use futures_util::StreamExt;
use reqwest::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{ipc::Channel, State};
use tokio_util::sync::CancellationToken;

use crate::context;
use crate::error::{AppError, ErrorKind};
use crate::gateway::{check, Gateway};
use crate::models::ModelInfo;
use crate::sse::SseParser;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPayload {
    pub model: String,
    /// Full conversation, oldest first, optionally starting with a system message.
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
    obj.insert("stream".into(), json!(true));
    obj.insert("stream_options".into(), json!({ "include_usage": true }));
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

/// Stream a chat completion. Always resolves `Ok`; outcomes (including errors) arrive as events,
/// and the last event is always `done` or `error`.
#[tauri::command]
pub async fn chat_stream(
    state: State<'_, AppState>,
    request_id: String,
    payload: ChatPayload,
    on_event: Channel<StreamEvent>,
) -> Result<(), AppError> {
    let send = |ev: StreamEvent| on_event.send(ev).is_ok();

    let token = CancellationToken::new();
    state.streams.lock().unwrap().insert(request_id.clone(), token.clone());
    let _guard = StreamGuard { state: &state, request_id };

    let key = match state.api_key().await {
        Ok(k) => k,
        Err(e) => {
            send(e.into());
            return Ok(());
        }
    };
    let model = state.model(&payload.model);
    run_chat(&state.gateway, &key, &model, payload, &token, send).await;
    Ok(())
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
        let body = match build_body(&model.id, &messages, payload.temperature, Some(max_tokens), extra) {
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

#[tauri::command]
pub fn chat_cancel(state: State<'_, AppState>, request_id: String) {
    if let Some(token) = state.streams.lock().unwrap().get(&request_id) {
        token.cancel();
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
        let body = build_body("qwen", &[user("hi")], Some(0.2), None, Some(&extra)).unwrap();
        assert_eq!(body["model"], "qwen");
        assert_eq!(body["stream"], true);
        assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert_eq!(body["messages"], json!([{ "role": "user", "content": "hi" }]));
        assert!(body.get("max_tokens").is_none());
        assert!(build_body("qwen", &[], None, None, None).is_err());
        assert!(build_body("qwen", &[ChatMessage { role: "tool".into(), content: "".into() }], None, None, None).is_err());
    }

    #[test]
    fn payload_shape_from_ui() {
        let p: ChatPayload = serde_json::from_str(
            r#"{"model":"qwen","messages":[{"role":"user","content":"hi"}],"maxTokens":64,"reasoning":false}"#).unwrap();
        assert_eq!((p.max_tokens, p.reasoning, p.temperature), (Some(64), Some(false), None));
        let ev = serde_json::to_value(StreamEvent::Trimmed { dropped: 2 }).unwrap();
        assert_eq!(ev, json!({ "type": "trimmed", "dropped": 2 }));
    }

    /// End-to-end against a running OpenAI-compatible server. Skipped unless ALPH_TEST_GATEWAY is set.
    ///   Mock:  ALPH_TEST_GATEWAY=http://127.0.0.1:8000 ALPH_TEST_MOCK=1 cargo test live_
    ///   Real:  ALPH_TEST_GATEWAY=http://127.0.0.1:8000 ALPH_TEST_MODEL=Qwen/Qwen3-1.7B cargo test live_ -- --nocapture
    /// ALPH_TEST_KEY defaults to "test". The real model must support chat_template_kwargs.enable_thinking.
    mod live {
        use super::*;
        use crate::config::{AppConfig, ModelMeta, ReasoningMeta};
        use crate::models;

        struct Live { gw: Gateway, key: String, model: String }

        fn setup() -> Option<Live> {
            let base = std::env::var("ALPH_TEST_GATEWAY").ok()?;
            Some(Live {
                gw: Gateway::with_base(&base).unwrap(),
                key: std::env::var("ALPH_TEST_KEY").unwrap_or_else(|_| "test".into()),
                model: std::env::var("ALPH_TEST_MODEL").unwrap_or_else(|_| "qwen".into()),
            })
        }

        fn is_mock() -> bool {
            std::env::var("ALPH_TEST_MOCK").is_ok()
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
            let payload = ChatPayload { model: model.into(), messages, temperature: None, max_tokens: None, reasoning };
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
