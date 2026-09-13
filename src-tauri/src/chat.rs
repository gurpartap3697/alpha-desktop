use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{ipc::Channel, State};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, ErrorKind};
use crate::gateway::{check, Gateway};
use crate::sse::SseParser;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPayload {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    /// Merged into the request body, e.g. a model's reasoning `onBody` / `offBody`.
    #[serde(default)]
    pub extra_body: Option<Map<String, Value>>,
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

pub fn build_body(payload: ChatPayload) -> Result<Value, AppError> {
    if payload.model.trim().is_empty() {
        return Err(AppError::new(ErrorKind::BadRequest, "No model selected"));
    }
    for m in &payload.messages {
        if !matches!(m.role.as_str(), "system" | "user" | "assistant") {
            return Err(AppError::new(ErrorKind::BadRequest, format!("Invalid role: {}", m.role)));
        }
    }
    let mut body = json!({});
    if let Some(extra) = payload.extra_body {
        deep_merge(&mut body, Value::Object(extra));
    }
    // Fields below always win over anything in extra_body.
    let obj = body.as_object_mut().expect("body is an object");
    obj.insert("model".into(), json!(payload.model));
    obj.insert(
        "messages".into(),
        Value::Array(
            payload.messages.into_iter()
                .map(|m| json!({ "role": m.role, "content": m.content }))
                .collect(),
        ),
    );
    obj.insert("stream".into(), json!(true));
    obj.insert("stream_options".into(), json!({ "include_usage": true }));
    if let Some(t) = payload.temperature {
        obj.insert("temperature".into(), json!(t));
    }
    if let Some(n) = payload.max_tokens {
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

    let Some(key) = state.api_key() else {
        send(AppError::new(ErrorKind::NoKey, "No API key set").into());
        return Ok(());
    };
    let body = match build_body(payload) {
        Ok(b) => b,
        Err(e) => {
            send(e.into());
            return Ok(());
        }
    };

    let token = CancellationToken::new();
    state.streams.lock().unwrap().insert(request_id.clone(), token.clone());
    let _guard = StreamGuard { state: &state, request_id };

    run_stream(&state.gateway, &key, &body, &token, send).await;
    Ok(())
}

/// POST the body and forward events to `send` until done, error, cancellation,
/// or `send` returning false (UI gone).
pub async fn run_stream(
    gateway: &Gateway,
    key: &str,
    body: &Value,
    token: &CancellationToken,
    mut send: impl FnMut(StreamEvent) -> bool,
) {
    let cancelled = || StreamEvent::Done { finish_reason: Some("cancelled".into()) };

    let request = gateway.post("/v1/chat/completions", key).json(body).send();
    let resp = tokio::select! {
        _ = token.cancelled() => { send(cancelled()); return; }
        r = request => r,
    };
    let resp = match resp {
        Ok(r) => match check(r).await {
            Ok(r) => r,
            Err(e) => { send(e.into()); return; }
        },
        Err(e) => { send(AppError::from(e).into()); return; }
    };

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
        let body = build_body(ChatPayload {
            model: "qwen".into(),
            messages: vec![ChatMessage { role: "user".into(), content: "hi".into() }],
            temperature: Some(0.2),
            max_tokens: None,
            extra_body: Some(extra),
        }).unwrap();
        assert_eq!(body["model"], "qwen");
        assert_eq!(body["stream"], true);
        assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(body.get("max_tokens").is_none());
    }

    /// End-to-end against a running OpenAI-compatible server. Skipped unless ALPH_TEST_GATEWAY is set.
    ///   Mock:  ALPH_TEST_GATEWAY=http://127.0.0.1:8000 ALPH_TEST_MOCK=1 cargo test live_
    ///   Real:  ALPH_TEST_GATEWAY=http://127.0.0.1:8000 ALPH_TEST_MODEL=Qwen/Qwen3-1.7B cargo test live_ -- --nocapture
    /// ALPH_TEST_KEY defaults to "test". The real model must support chat_template_kwargs.enable_thinking.
    mod live {
        use super::*;

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

        async fn collect(gw: &Gateway, key: &str, model: &str, prompt: &str, extra: Option<Value>,
                         token: &CancellationToken) -> Vec<StreamEvent> {
            let body = build_body(ChatPayload {
                model: model.into(),
                messages: vec![ChatMessage { role: "user".into(), content: prompt.into() }],
                temperature: None,
                max_tokens: Some(1024),
                extra_body: extra.and_then(|v| v.as_object().cloned()),
            }).unwrap();
            let mut evs = Vec::new();
            run_stream(gw, key, &body, token, |ev| { evs.push(ev); true }).await;
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
        async fn live_stream_with_and_without_reasoning() {
            let Some(l) = setup() else { return };
            let t = CancellationToken::new();
            let prompt = "Say hello in one short sentence.";

            let on = collect(&l.gw, &l.key, &l.model, prompt,
                Some(json!({ "chat_template_kwargs": { "enable_thinking": true } })), &t).await;
            println!("[thinking on]\nreasoning: {}\ncontent: {}\nlast: {:?}", text(&on, true), text(&on, false), on.last());
            assert!(!text(&on, true).is_empty(), "expected reasoning deltas");
            assert!(on.iter().any(|e| matches!(e, StreamEvent::Usage { .. })), "expected usage");
            assert!(finished(&on));

            let off = collect(&l.gw, &l.key, &l.model, prompt,
                Some(json!({ "chat_template_kwargs": { "enable_thinking": false } })), &t).await;
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
            let evs = collect(&l.gw, &l.key, &l.model, &long, None, &t).await;
            println!("context: {:?}", evs.last());
            assert_eq!(last_err(&evs).0, ErrorKind::ContextLength);

            let evs = collect(&l.gw, &l.key, "no-such-model", "hi", None, &t).await;
            println!("unknown model: {:?}", evs.last());
            if !is_mock() {
                assert_eq!(last_err(&evs).0, ErrorKind::ModelUnavailable);
            }

            let dead = Gateway::with_base("http://127.0.0.1:9").unwrap();
            assert_eq!(last_err(&collect(&dead, &l.key, &l.model, "hi", None, &t).await).0, ErrorKind::Unreachable);
        }

        #[tokio::test]
        async fn live_mock_simulated_errors() {
            let Some(l) = setup() else { return };
            if !is_mock() { return; }
            let t = CancellationToken::new();
            let run = |p: &'static str| collect(&l.gw, &l.key, &l.model, p, None, &t);
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
            let evs = collect(&l.gw, &l.key, &l.model, "/slow Write a 300-word story about a lighthouse.", None, &t).await;
            assert!(matches!(evs.last(), Some(StreamEvent::Done { finish_reason: Some(r) }) if r == "cancelled"),
                    "got {:?}", evs.last());
        }
    }
}
