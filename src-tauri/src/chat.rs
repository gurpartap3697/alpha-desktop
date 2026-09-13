use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{ipc::Channel, State};
use tokio_util::sync::CancellationToken;

use crate::context;
use crate::db::{AnswerUpdate, ConversationSummary, Db, Message, TurnRequest};
use crate::error::{AppError, ErrorKind};
use crate::gateway::{check, Gateway};
use crate::models::ModelInfo;
use crate::sse::SseParser;
use crate::state::{ActiveStream, AppState};

/// How often a streaming answer is written to the database.
const SAVE_INTERVAL: Duration = Duration::from_millis(750);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug)]
pub struct ChatPayload {
    /// Conversation to send, oldest first, optionally starting with a system message.
    /// Trimmed to the model's context window before sending.
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f64>,
    /// Defaults to the model's `maxOutputTokens`.
    pub max_tokens: Option<u32>,
    /// Reasoning on/off for models that support the toggle. `None` = the model's default.
    pub reasoning: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Usage {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

/// Events sent to the UI over the Tauri channel. Serialized as `{ "type": "content_delta", ... }`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    /// First event: the saved conversation and the messages created or changed for this turn
    /// (the last one is the answer being streamed).
    Started { conversation: ConversationSummary, messages: Vec<Message> },
    /// Sent before any delta when older messages were left out to fit the context window.
    Trimmed { dropped: usize },
    ContentDelta { text: String },
    ReasoningDelta { text: String },
    Usage { usage: Usage },
    /// `finish_reason` is the server's (`stop`, `length`, ...) or `cancelled` when the user stopped it.
    Done { finish_reason: Option<String> },
    Error { kind: ErrorKind, message: String, retry_after: Option<u64> },
}

impl From<AppError> for StreamEvent {
    fn from(e: AppError) -> Self {
        StreamEvent::Error { kind: e.kind, message: e.message, retry_after: e.retry_after }
    }
}

pub fn build_body(
    model: &str,
    messages: &[ChatMessage],
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    extra: Option<&Map<String, Value>>,
    stream: bool,
) -> Result<Value, AppError> {
    if model.trim().is_empty() {
        return Err(AppError::new(ErrorKind::BadRequest, "No model selected"));
    }
    if messages.is_empty() {
        return Err(AppError::new(ErrorKind::BadRequest, "No messages to send"));
    }
    for m in messages {
        if !matches!(m.role.as_str(), "system" | "user" | "assistant") {
            return Err(AppError::new(ErrorKind::BadRequest, format!("Invalid role: {}", m.role)));
        }
    }
    let mut body = json!({});
    if let Some(extra) = extra {
        deep_merge(&mut body, Value::Object(extra.clone()));
    }
    // Fields below always win over anything in `extra`.
    let obj = body.as_object_mut().expect("body is an object");
    obj.insert("model".into(), json!(model));
    obj.insert("messages".into(), json!(messages));
    obj.insert("stream".into(), json!(stream));
    if stream {
        obj.insert("stream_options".into(), json!({ "include_usage": true }));
    }
    if let Some(t) = temperature {
        obj.insert("temperature".into(), json!(t));
    }
    if let Some(n) = max_tokens {
        obj.insert("max_tokens".into(), json!(n));
    }
    Ok(body)
}

fn deep_merge(target: &mut Value, patch: Value) {
    match (target, patch) {
        (Value::Object(t), Value::Object(p)) => {
            for (k, v) in p {
                deep_merge(t.entry(k).or_insert(Value::Null), v);
            }
        }
        (t, p) => *t = p,
    }
}

#[derive(Deserialize)]
struct Chunk {
    #[serde(default)]
    choices: Vec<Choice>,
    usage: Option<Usage>,
    error: Option<Value>,
}

#[derive(Deserialize)]
struct Choice {
    delta: Option<Delta>,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct Delta {
    content: Option<String>,
    /// Newer vLLM.
    reasoning: Option<String>,
    /// Older vLLM and LiteLLM's normalized field.
    reasoning_content: Option<String>,
}

/// Tracks one streamed completion.
#[derive(Default)]
pub struct StreamState {
    pub finish_reason: Option<String>,
    pub done: bool,
}

/// Convert one SSE `data` payload into UI events.
pub fn events_from_data(data: &str, st: &mut StreamState) -> Vec<StreamEvent> {
    let data = data.trim();
    if data == "[DONE]" {
        st.done = true;
        return vec![StreamEvent::Done { finish_reason: st.finish_reason.clone() }];
    }
    let chunk: Chunk = match serde_json::from_str(data) {
        Ok(c) => c,
        Err(e) => {
            return vec![AppError::new(ErrorKind::Protocol, format!("Unparseable stream chunk ({e}): {}",
                data.chars().take(200).collect::<String>())).into()]
        }
    };
    let mut out = Vec::new();
    if let Some(err) = chunk.error {
        let msg = crate::error::extract_message(&json!({ "error": err }).to_string())
            .unwrap_or_else(|| "Stream error".into());
        let kind = if crate::error::is_context_error(&msg) { ErrorKind::ContextLength } else { ErrorKind::Server };
        st.done = true;
        out.push(AppError::new(kind, msg).into());
        return out;
    }
    for choice in chunk.choices {
        if let Some(delta) = choice.delta {
            // Some servers send both fields with identical text; take one.
            if let Some(r) = delta.reasoning.or(delta.reasoning_content).filter(|s| !s.is_empty()) {
                out.push(StreamEvent::ReasoningDelta { text: r });
            }
            if let Some(c) = delta.content.filter(|s| !s.is_empty()) {
                out.push(StreamEvent::ContentDelta { text: c });
            }
        }
        if let Some(fr) = choice.finish_reason {
            st.finish_reason = Some(fr);
        }
    }
    if let Some(u) = chunk.usage {
        out.push(StreamEvent::Usage { usage: u });
    }
    out
}

/// Removes the request's cancellation token when the stream ends, however it ends.
struct StreamGuard<'a> {
    state: &'a AppState,
    request_id: String,
}

impl Drop for StreamGuard<'_> {
    fn drop(&mut self) {
        self.state.streams.lock().unwrap().remove(&self.request_id);
    }
}

/// Save the user's action (new message, regenerate, or edit), then stream and save the answer.
///
/// Fails only if nothing was saved (invalid request, chat busy or missing, database error). Otherwise
/// resolves `Ok`: the first event is `started`, the last is `done` or `error`, and the answer's final
/// state is in the database before the last event is sent.
#[tauri::command]
pub async fn chat_send(
    state: State<'_, AppState>,
    request_id: String,
    request: TurnRequest,
    on_event: Channel<StreamEvent>,
) -> Result<(), AppError> {
    send_turn(&state, request_id, request, |ev| on_event.send(ev).is_ok()).await
}

/// `chat_send` without the Tauri plumbing. `send` returns false once nobody is listening.
pub async fn send_turn(
    state: &AppState,
    request_id: String,
    request: TurnRequest,
    send: impl FnMut(StreamEvent) -> bool,
) -> Result<(), AppError> {
    let db = state.db()?;
    let token = CancellationToken::new();
    {
        let mut streams = state.streams.lock().unwrap();
        if let Some(cid) = &request.conversation_id {
            if streams.values().any(|s| s.conversation_id.as_deref() == Some(cid)) {
                return Err(AppError::new(ErrorKind::BadRequest, "This chat is still answering"));
            }
        }
        streams.insert(request_id.clone(),
                       ActiveStream { token: token.clone(), conversation_id: request.conversation_id.clone() });
    }
    let _guard = StreamGuard { state, request_id: request_id.clone() };

    let prepared = db.prepare_turn(&request)?;
    if let Some(s) = state.streams.lock().unwrap().get_mut(&request_id) {
        s.conversation_id = Some(prepared.conversation.id.clone());
    }
    let answer_id = prepared.answer().id.clone();
    let mut recorder = Recorder::new(db, answer_id, send);
    recorder.forward(StreamEvent::Started { conversation: prepared.conversation, messages: prepared.changed });

    match state.api_key().await {
        Err(e) => {
            recorder.event(e.into());
        }
        Ok(key) => {
            let model = state.model(&request.model);
            let payload = ChatPayload {
                temperature: request.params.temperature.or(Some(model.temperature)),
                max_tokens: request.params.max_tokens,
                reasoning: request.params.reasoning,
                messages: prepared.history,
            };
            run_chat(&state.gateway, &key, &model, payload, &token, |ev| recorder.event(ev)).await;
        }
    }
    recorder.close();
    Ok(())
}

/// Saves a streamed answer as events pass through: the text periodically, the final state before
/// the last event is forwarded.
struct Recorder<'a, F: FnMut(StreamEvent) -> bool> {
    db: &'a Db,
    id: String,
    send: F,
    answer: AnswerUpdate,
    started: Instant,
    last_save: Instant,
    unsaved: bool,
    finished: bool,
}

impl<'a, F: FnMut(StreamEvent) -> bool> Recorder<'a, F> {
    fn new(db: &'a Db, id: String, send: F) -> Self {
        let now = Instant::now();
        Self { db, id, send, answer: AnswerUpdate::default(), started: now, last_save: now, unsaved: false, finished: false }
    }

    fn forward(&mut self, ev: StreamEvent) -> bool {
        (self.send)(ev)
    }

    fn event(&mut self, ev: StreamEvent) -> bool {
        let a = &mut self.answer;
        match &ev {
            StreamEvent::Started { .. } => {}
            StreamEvent::Trimmed { dropped } => a.dropped = Some(*dropped),
            StreamEvent::ReasoningDelta { text } => {
                a.reasoning.push_str(text);
                self.unsaved = true;
            }
            StreamEvent::ContentDelta { text } => {
                if a.content.is_empty() && !a.reasoning.is_empty() {
                    a.reasoning_ms = Some(self.started.elapsed().as_millis() as u64);
                }
                a.content.push_str(text);
                self.unsaved = true;
            }
            StreamEvent::Usage { usage } => {
                a.prompt_tokens = usage.prompt_tokens;
                a.completion_tokens = usage.completion_tokens;
            }
            StreamEvent::Done { finish_reason } => {
                let stopped = finish_reason.as_deref() == Some("cancelled");
                a.status = Some(if stopped { "stopped" } else { "complete" });
                a.finish_reason = finish_reason.clone();
                self.finish();
            }
            StreamEvent::Error { kind, message, retry_after } => {
                // A dropped connection keeps what arrived, like a stop.
                let partial = *kind == ErrorKind::StreamDropped && !a.content.is_empty();
                a.status = Some(if partial { "stopped" } else { "error" });
                a.error = Some(AppError { kind: *kind, message: message.clone(), retry_after: *retry_after });
                self.finish();
            }
        }
        if self.unsaved && !self.finished && self.last_save.elapsed() >= SAVE_INTERVAL {
            self.unsaved = false;
            self.last_save = Instant::now();
            if let Err(e) = self.db.save_progress(&self.id, &self.answer.content, &self.answer.reasoning) {
                eprintln!("history: saving answer progress failed: {e}");
            }
        }
        self.forward(ev)
    }

    fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        let a = &mut self.answer;
        if a.reasoning_ms.is_none() && !a.reasoning.is_empty() {
            a.reasoning_ms = Some(self.started.elapsed().as_millis() as u64);
        }
        if let Err(e) = self.db.finish_answer(&self.id, &self.answer) {
            eprintln!("history: saving answer failed: {e}");
        }
    }

    /// The stream ended without a final event (the window closed): keep what arrived.
    fn close(&mut self) {
        if !self.finished {
            let a = &mut self.answer;
            a.status = Some(if a.content.is_empty() { "error" } else { "stopped" });
            a.error = Some(AppError::new(ErrorKind::Interrupted, "The answer was interrupted"));
            self.finish();
        }
    }
}

fn cancelled() -> StreamEvent {
    StreamEvent::Done { finish_reason: Some("cancelled".into()) }
}

/// Fit the conversation into the model's context window and stream the reply. If the server still
/// says the prompt is too long, leave out the older half of the history and retry once.
pub async fn run_chat(
    gateway: &Gateway,
    key: &str,
    model: &ModelInfo,
    payload: ChatPayload,
    token: &CancellationToken,
    mut send: impl FnMut(StreamEvent) -> bool,
) {
    let max_tokens = payload.max_tokens.unwrap_or(model.max_output_tokens);
    let budget = context::prompt_budget(model.context_window, max_tokens);
    let (mut messages, mut dropped) = context::fit(&payload.messages, budget);
    let extra = model.reasoning_body(payload.reasoning);
    let mut retried = false;

    loop {
        let body = match build_body(&model.id, &messages, payload.temperature, Some(max_tokens), extra, true) {
            Ok(b) => b,
            Err(e) => {
                send(e.into());
                return;
            }
        };
        let request = gateway.post("/v1/chat/completions", key).json(&body).send();
        let resp = tokio::select! {
            _ = token.cancelled() => { send(cancelled()); return; }
            r = request => r,
        };
        let err = match resp {
            Ok(r) => match check(r).await {
                Ok(r) => {
                    if dropped > 0 && !send(StreamEvent::Trimmed { dropped }) {
                        return;
                    }
                    pump(r, token, send).await;
                    return;
                }
                Err(e) => e,
            },
            Err(e) => AppError::from(e),
        };
        if err.kind == ErrorKind::ContextLength && !retried {
            if let Some(fewer) = context::drop_older_half(&messages) {
                dropped += messages.len() - fewer.len();
                messages = fewer;
                retried = true;
                continue;
            }
        }
        send(err.into());
        return;
    }
}

/// Forward a streaming response's events to `send` until done, error, cancellation,
/// or `send` returning false (UI gone).
async fn pump(resp: Response, token: &CancellationToken, mut send: impl FnMut(StreamEvent) -> bool) {
    let mut bytes = resp.bytes_stream();
    let mut parser = SseParser::new();
    let mut st = StreamState::default();
    loop {
        let next = tokio::select! {
            _ = token.cancelled() => { send(cancelled()); return; } // dropping `bytes` closes the connection
            n = bytes.next() => n,
        };
        let ended = next.is_none();
        let payloads = match next {
            Some(Ok(chunk)) => parser.push(&chunk),
            Some(Err(e)) => {
                let mut err = AppError::from(e);
                if err.kind == ErrorKind::Unreachable { err.kind = ErrorKind::StreamDropped; }
                send(err.into());
                return;
            }
            None => parser.finish().into_iter().collect(),
        };
        for data in payloads {
            for ev in events_from_data(&data, &mut st) {
                if !send(ev) {
                    return;
                }
            }
            if st.done {
                return;
            }
        }
        if ended {
            break;
        }
    }

    // EOF without [DONE]. If the server already reported a finish reason, treat it as complete.
    if st.finish_reason.is_some() {
        send(StreamEvent::Done { finish_reason: st.finish_reason });
    } else {
        send(AppError::new(ErrorKind::StreamDropped, "Connection closed before the response finished").into());
    }
}

/// A non-streaming completion, for short internal requests such as titles.
pub async fn complete(
    gateway: &Gateway,
    key: &str,
    model: &ModelInfo,
    messages: &[ChatMessage],
    max_tokens: u32,
    reasoning: Option<bool>,
) -> Result<String, AppError> {
    let body = build_body(&model.id, messages, Some(0.3), Some(max_tokens), model.reasoning_body(reasoning), false)?;
    let req = gateway.post("/v1/chat/completions", key).timeout(Duration::from_secs(30)).json(&body);
    let resp = check(req.send().await?).await?;
    let v: Value = resp.json().await
        .map_err(|e| AppError::new(ErrorKind::Protocol, format!("Unexpected completion response: {e}")))?;
    Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_owned())
}

#[tauri::command]
pub fn chat_cancel(state: State<'_, AppState>, request_id: String) {
    if let Some(s) = state.streams.lock().unwrap().get(&request_id) {
        s.token.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(content: &str) -> ChatMessage {
        ChatMessage { role: "user".into(), content: content.into() }
    }

    #[test]
    fn reads_both_reasoning_field_names() {
        let mut st = StreamState::default();
        let a = events_from_data(r#"{"choices":[{"delta":{"reasoning":"think"}}]}"#, &mut st);
        let b = events_from_data(r#"{"choices":[{"delta":{"reasoning_content":"old"}}]}"#, &mut st);
        let c = events_from_data(
            r#"{"choices":[{"delta":{"reasoning":"x","reasoning_content":"x","content":null}}]}"#, &mut st);
        assert_eq!(a, vec![StreamEvent::ReasoningDelta { text: "think".into() }]);
        assert_eq!(b, vec![StreamEvent::ReasoningDelta { text: "old".into() }]);
        assert_eq!(c, vec![StreamEvent::ReasoningDelta { text: "x".into() }]);
    }

    #[test]
    fn full_stream_sequence() {
        let mut st = StreamState::default();
        let mut evs = Vec::new();
        for d in [
            r#"{"choices":[{"delta":{"role":"assistant","content":""}}]}"#,
            r#"{"choices":[{"delta":{"content":"Hi"}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            r#"{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}"#,
            "[DONE]",
        ] {
            evs.extend(events_from_data(d, &mut st));
        }
        assert_eq!(evs, vec![
            StreamEvent::ContentDelta { text: "Hi".into() },
            StreamEvent::Usage { usage: Usage { prompt_tokens: Some(5), completion_tokens: Some(1), total_tokens: Some(6) } },
            StreamEvent::Done { finish_reason: Some("stop".into()) },
        ]);
        assert!(st.done);
    }

    #[test]
    fn mid_stream_error_object() {
        let mut st = StreamState::default();
        let evs = events_from_data(r#"{"error":{"message":"maximum context length exceeded"}}"#, &mut st);
        assert!(matches!(evs.as_slice(), [StreamEvent::Error { kind: ErrorKind::ContextLength, .. }]));
        assert!(st.done);
    }

    #[test]
    fn body_merges_extra_but_core_fields_win() {
        let extra: Map<String, Value> = serde_json::from_str(
            r#"{"chat_template_kwargs":{"enable_thinking":false},"stream":false,"model":"evil"}"#).unwrap();
        let body = build_body("qwen", &[user("hi")], Some(0.2), None, Some(&extra), true).unwrap();
        assert_eq!(body["model"], "qwen");
        assert_eq!(body["stream"], true);
        assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert_eq!(body["messages"], json!([{ "role": "user", "content": "hi" }]));
        assert!(body.get("max_tokens").is_none());
        assert!(build_body("qwen", &[], None, None, None, true).is_err());
        assert!(build_body("qwen", &[ChatMessage { role: "tool".into(), content: "".into() }], None, None, None, true).is_err());
        let plain = build_body("qwen", &[user("hi")], None, Some(20), None, false).unwrap();
        assert_eq!((plain["stream"].clone(), plain.get("stream_options")), (json!(false), None));
    }

    #[test]
    fn request_shape_from_ui() {
        use crate::db::TurnAction;
        let r: TurnRequest = serde_json::from_str(r#"{"conversationId":"c1","model":"qwen","systemPrompt":null,
            "action":{"type":"edit","messageId":"m1","content":"hi"},
            "params":{"temperature":null,"maxTokens":64,"reasoning":false}}"#).unwrap();
        assert!(matches!(r.action, TurnAction::Edit { ref message_id, .. } if message_id == "m1"));
        assert_eq!((r.params.max_tokens, r.params.reasoning, r.params.temperature), (Some(64), Some(false), None));
        let r: TurnRequest = serde_json::from_str(
            r#"{"conversationId":null,"model":"qwen","action":{"type":"regenerate"}}"#).unwrap();
        assert!(matches!(r.action, TurnAction::Regenerate) && r.conversation_id.is_none());
        let ev = serde_json::to_value(StreamEvent::Trimmed { dropped: 2 }).unwrap();
        assert_eq!(ev, json!({ "type": "trimmed", "dropped": 2 }));
    }

    fn record(events: Vec<StreamEvent>) -> (crate::db::Message, usize) {
        use crate::db::{Params, TurnAction};
        let db = Db::open_in_memory();
        let t = db.prepare_turn(&TurnRequest {
            conversation_id: None, action: TurnAction::Send { content: "hi".into() }, model: "qwen".into(),
            system_prompt: None, params: Params::default(),
        }).unwrap();
        let mut forwarded = 0;
        let mut rec = Recorder::new(&db, t.answer().id.clone(), |_| { forwarded += 1; true });
        for ev in events {
            rec.event(ev);
        }
        rec.close();
        drop(rec);
        (db.get(&t.conversation.id).unwrap().messages.pop().unwrap(), forwarded)
    }

    #[test]
    fn recorder_saves_final_states() {
        let delta = |t: &str| StreamEvent::ContentDelta { text: t.into() };
        let (m, n) = record(vec![
            StreamEvent::Trimmed { dropped: 2 },
            StreamEvent::ReasoningDelta { text: "hmm".into() },
            delta("Hel"), delta("lo"),
            StreamEvent::Usage { usage: Usage { prompt_tokens: Some(3), completion_tokens: Some(2), total_tokens: None } },
            StreamEvent::Done { finish_reason: Some("stop".into()) },
        ]);
        assert_eq!(n, 6);
        assert_eq!((m.status.as_str(), m.content.as_str(), m.reasoning.as_deref()), ("complete", "Hello", Some("hmm")));
        assert_eq!((m.dropped, m.completion_tokens, m.finish_reason.as_deref()), (Some(2), Some(2), Some("stop")));
        assert!(m.reasoning_ms.is_some());

        let (m, _) = record(vec![delta("part"), StreamEvent::Done { finish_reason: Some("cancelled".into()) }]);
        assert_eq!((m.status.as_str(), m.content.as_str()), ("stopped", "part"));

        let (m, _) = record(vec![delta("part"),
            AppError::new(ErrorKind::StreamDropped, "closed").into()]);
        assert_eq!((m.status.as_str(), m.error.unwrap().kind), ("stopped", ErrorKind::StreamDropped));

        let (m, _) = record(vec![AppError { kind: ErrorKind::RateLimited, message: "slow down".into(), retry_after: Some(7) }.into()]);
        assert_eq!(m.status, "error");
        assert_eq!(m.error.unwrap().retry_after, Some(7));

        let (m, _) = record(vec![delta("cut off")]);
        assert_eq!((m.status.as_str(), m.error.unwrap().kind), ("stopped", ErrorKind::Interrupted));
    }

    /// End-to-end against a running OpenAI-compatible server. Skipped unless ALPHA_TEST_GATEWAY is set.
    ///   Mock:  ALPHA_TEST_GATEWAY=http://127.0.0.1:8000 ALPHA_TEST_MOCK=1 cargo test live_
    ///   Real:  ALPHA_TEST_GATEWAY=http://127.0.0.1:8000 ALPHA_TEST_MODEL=Qwen/Qwen3-1.7B cargo test live_ -- --nocapture
    /// ALPHA_TEST_KEY defaults to "test". The real model must support chat_template_kwargs.enable_thinking.
    mod live {
        use super::*;
        use crate::config::{AppConfig, ModelMeta, ReasoningMeta};
        use crate::models;

        struct Live { gw: Gateway, key: String, model: String }

        fn setup() -> Option<Live> {
            let base = std::env::var("ALPHA_TEST_GATEWAY").ok()?;
            Some(Live {
                gw: Gateway::with_base(&base).unwrap(),
                key: std::env::var("ALPHA_TEST_KEY").unwrap_or_else(|_| "test".into()),
                model: std::env::var("ALPHA_TEST_MODEL").unwrap_or_else(|_| "qwen".into()),
            })
        }

        fn is_mock() -> bool {
            std::env::var("ALPHA_TEST_MOCK").is_ok()
        }

        /// The model with a Qwen-style reasoning toggle and a window large enough that the app
        /// doesn't trim, so the server's own context check is exercised.
        fn model_info(id: &str) -> ModelInfo {
            let body = |on: bool| json!({ "chat_template_kwargs": { "enable_thinking": on } }).as_object().cloned();
            let mut config = AppConfig::default();
            config.models.insert(id.into(), ModelMeta {
                context_window: Some(1_000_000),
                max_output_tokens: Some(1024),
                reasoning: ReasoningMeta { supported: true, default_on: true, on_body: body(true), off_body: body(false) },
                ..Default::default()
            });
            models::resolve(id, None, &config)
        }

        async fn collect(gw: &Gateway, key: &str, model: &str, messages: Vec<ChatMessage>, reasoning: Option<bool>,
                         token: &CancellationToken) -> Vec<StreamEvent> {
            let payload = ChatPayload { messages, temperature: None, max_tokens: None, reasoning };
            let mut evs = Vec::new();
            run_chat(gw, key, &model_info(model), payload, token, |ev| { evs.push(ev); true }).await;
            evs
        }

        fn text(evs: &[StreamEvent], reasoning: bool) -> String {
            evs.iter().filter_map(|e| match e {
                StreamEvent::ContentDelta { text } if !reasoning => Some(text.as_str()),
                StreamEvent::ReasoningDelta { text } if reasoning => Some(text.as_str()),
                _ => None,
            }).collect()
        }

        fn last_err(evs: &[StreamEvent]) -> (ErrorKind, Option<u64>) {
            match evs.last() {
                Some(StreamEvent::Error { kind, retry_after, .. }) => (*kind, *retry_after),
                other => panic!("expected error, got {other:?}"),
            }
        }

        fn finished(evs: &[StreamEvent]) -> bool {
            matches!(evs.last(), Some(StreamEvent::Done { finish_reason: Some(r) }) if r == "stop" || r == "length")
        }

        #[tokio::test]
        async fn live_list_models() {
            let Some(l) = setup() else { return };
            let served = models::fetch(&l.gw, &l.key).await.unwrap();
            println!("served: {served:?}");
            assert!(served.iter().any(|m| m.id == l.model), "{} not served", l.model);
        }

        #[tokio::test]
        async fn live_stream_with_and_without_reasoning() {
            let Some(l) = setup() else { return };
            let t = CancellationToken::new();
            let prompt = || vec![user("Say hello in one short sentence.")];

            let on = collect(&l.gw, &l.key, &l.model, prompt(), Some(true), &t).await;
            println!("[thinking on]\nreasoning: {}\ncontent: {}\nlast: {:?}", text(&on, true), text(&on, false), on.last());
            assert!(!text(&on, true).is_empty(), "expected reasoning deltas");
            assert!(on.iter().any(|e| matches!(e, StreamEvent::Usage { .. })), "expected usage");
            assert!(finished(&on));

            let off = collect(&l.gw, &l.key, &l.model, prompt(), Some(false), &t).await;
            println!("[thinking off]\ncontent: {}\nlast: {:?}", text(&off, false), off.last());
            assert!(text(&off, true).is_empty(), "expected no reasoning");
            assert!(!text(&off, false).trim().is_empty(), "expected content");
            assert!(finished(&off));
        }

        #[tokio::test]
        async fn live_error_kinds() {
            let Some(l) = setup() else { return };
            let t = CancellationToken::new();

            let long = "hello ".repeat(100_000); // ~100k tokens: over any test model's context
            let evs = collect(&l.gw, &l.key, &l.model, vec![user(&long)], None, &t).await;
            println!("context: {:?}", evs.last());
            assert_eq!(last_err(&evs).0, ErrorKind::ContextLength);

            let evs = collect(&l.gw, &l.key, "no-such-model", vec![user("hi")], None, &t).await;
            println!("unknown model: {:?}", evs.last());
            if !is_mock() {
                assert_eq!(last_err(&evs).0, ErrorKind::ModelUnavailable);
            }

            let dead = Gateway::with_base("http://127.0.0.1:9").unwrap();
            let evs = collect(&dead, &l.key, &l.model, vec![user("hi")], None, &t).await;
            assert_eq!(last_err(&evs).0, ErrorKind::Unreachable);
        }

        #[tokio::test]
        async fn live_context_error_retries_without_old_turns() {
            let Some(l) = setup() else { return };
            let t = CancellationToken::new();
            let history = vec![
                user(&"hello ".repeat(100_000)),
                ChatMessage { role: "assistant".into(), content: "Hello!".into() },
                user("Reply with just the word OK."),
            ];
            let evs = collect(&l.gw, &l.key, &l.model, history, Some(false), &t).await;
            println!("retry: first={:?} last={:?} content={}", evs.first(), evs.last(), text(&evs, false));
            assert_eq!(evs.first(), Some(&StreamEvent::Trimmed { dropped: 2 }));
            assert!(finished(&evs));
        }

        #[tokio::test]
        async fn live_mock_simulated_errors() {
            let Some(l) = setup() else { return };
            if !is_mock() { return; }
            let t = CancellationToken::new();
            let run = |p: &'static str| collect(&l.gw, &l.key, &l.model, vec![user(p)], None, &t);
            assert_eq!(last_err(&run("/error 429").await), (ErrorKind::RateLimited, Some(7)));
            assert_eq!(last_err(&run("/error 401").await).0, ErrorKind::Unauthorized);
            assert_eq!(last_err(&run("/drop").await).0, ErrorKind::StreamDropped);
        }

        /// Six long turns through the whole command path with a small context window: every answer
        /// streams, later ones leave out older messages, and everything is on disk afterwards.
        #[tokio::test]
        async fn live_long_conversation_is_saved_and_trimmed() {
            use crate::credentials::{Credentials, FileStore};
            use crate::db::{Params, TurnAction};
            use crate::state::HISTORY_FILE;

            let Some(l) = setup() else { return };
            let dir = tempfile::tempdir().unwrap();
            let credentials = Credentials::new(
                Box::new(FileStore::new(dir.path().join("k1"))),
                Box::new(FileStore::new(dir.path().join("k2"))),
            );
            credentials.save(&l.key).unwrap();
            let state = AppState::with_credentials(l.gw, dir.path().to_owned(), credentials);
            let mut info = model_info(&l.model);
            (info.context_window, info.max_output_tokens) = (1200, 200);
            state.models.write().unwrap().insert(l.model.clone(), info);

            let mut conversation_id = None;
            for i in 0..6 {
                let request = TurnRequest {
                    conversation_id: conversation_id.clone(),
                    action: TurnAction::Send {
                        content: format!("Message {i}. {}\nReply with just the word OK.", "Some filler text. ".repeat(55)),
                    },
                    model: l.model.clone(),
                    system_prompt: Some("Be brief.".into()),
                    params: Params { temperature: None, max_tokens: Some(100), reasoning: Some(false) },
                };
                let mut evs = Vec::new();
                send_turn(&state, format!("r{i}"), request, |ev| { evs.push(ev); true }).await.unwrap();
                let Some(StreamEvent::Started { conversation, .. }) = evs.first() else { panic!("{:?}", evs.first()) };
                conversation_id = Some(conversation.id.clone());
                println!("turn {i}: {:?} / {:?}", evs.get(1), evs.last());
                assert!(finished(&evs), "turn {i} ended with {:?}", evs.last());
            }
            assert!(state.streams.lock().unwrap().is_empty());
            drop(state);

            let db = Db::open(&dir.path().join(HISTORY_FILE)).unwrap();
            let c = db.get(conversation_id.as_deref().unwrap()).unwrap();
            assert_eq!(c.messages.len(), 12);
            assert!(c.messages.iter().all(|m| m.status == "complete" && !m.content.is_empty()), "{:#?}", c.messages);
            assert!(c.messages.last().unwrap().dropped.unwrap_or(0) > 0, "expected older messages to be left out");
        }

        #[tokio::test]
        async fn live_title() {
            let Some(l) = setup() else { return };
            let input = crate::db::TitleInput {
                model_id: l.model.clone(),
                question: "How do I make a Docker container reach a service running on my Mac?".into(),
                answer: "Use host.docker.internal as the hostname instead of localhost.".into(),
            };
            let title = crate::titles::generate(&l.gw, &l.key, &model_info(&l.model), &input).await.unwrap();
            println!("title: {title:?}");
            assert!(title.is_some_and(|t| !t.is_empty() && t.chars().count() <= 81));
        }

        #[tokio::test]
        async fn live_cancel() {
            let Some(l) = setup() else { return };
            let t = CancellationToken::new();
            let t2 = t.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                t2.cancel();
            });
            // "/slow" makes the mock stream slowly; a real model just sees it as text.
            let prompt = vec![user("/slow Write a 300-word story about a lighthouse.")];
            let evs = collect(&l.gw, &l.key, &l.model, prompt, None, &t).await;
            assert!(matches!(evs.last(), Some(StreamEvent::Done { finish_reason: Some(r) }) if r == "cancelled"),
                    "got {:?}", evs.last());
        }
    }
}
