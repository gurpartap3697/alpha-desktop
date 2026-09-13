use reqwest::StatusCode;
use serde::Serialize;

/// Error categories the UI designs a state for (see "Error states" in plan.md).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// Connect failure, TLS failure or timeout — typically off VPN or gateway down.
    Unreachable,
    /// 401/403 — key missing, invalid or revoked.
    Unauthorized,
    RateLimited,
    ModelUnavailable,
    ContextLength,
    BadRequest,
    Server,
    /// Connection ended before the server signalled completion.
    StreamDropped,
    /// Unexpected response shape.
    Protocol,
    NoKey,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), retry_after: None }
    }

    /// Map a non-success HTTP response to an error kind.
    pub fn from_response(status: StatusCode, retry_after: Option<u64>, body: &str) -> Self {
        let message = extract_message(body)
            .unwrap_or_else(|| body.chars().take(500).collect::<String>());
        let message = if message.trim().is_empty() { status.to_string() } else { message };
        let kind = match status.as_u16() {
            401 | 403 => ErrorKind::Unauthorized,
            429 => ErrorKind::RateLimited,
            404 => ErrorKind::ModelUnavailable,
            400 | 413 | 422 if is_context_error(&message) => ErrorKind::ContextLength,
            400 | 413 | 422 => ErrorKind::BadRequest,
            _ if is_context_error(&message) => ErrorKind::ContextLength,
            _ => ErrorKind::Server,
        };
        Self { kind, message, retry_after }
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        let kind = if e.is_connect() || e.is_timeout() {
            ErrorKind::Unreachable
        } else if e.is_body() || e.is_decode() {
            ErrorKind::StreamDropped
        } else {
            ErrorKind::Unreachable
        };
        Self::new(kind, error_chain(&e))
    }
}

/// Full `source()` chain, so TLS / certificate problems are visible instead of
/// a bare "error sending request".
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        let s_str = s.to_string();
        if !msg.contains(&s_str) {
            msg.push_str(": ");
            msg.push_str(&s_str);
        }
        src = s.source();
    }
    msg
}

/// OpenAI / LiteLLM / vLLM error bodies: `{"error":{"message":..}}`, `{"error":".."}`,
/// `{"message":".."}` or `{"detail":..}`.
pub fn extract_message(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let pick = |v: &serde_json::Value| -> Option<String> {
        match v {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Null => None,
            other => other.get("message").and_then(|m| m.as_str()).map(str::to_owned)
                .or_else(|| Some(other.to_string())),
        }
    };
    v.get("error").and_then(pick)
        .or_else(|| v.get("message").and_then(pick))
        .or_else(|| v.get("detail").and_then(pick))
}

pub fn is_context_error(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("maximum context length")
        || m.contains("context length")
        || m.contains("context_length")
        || m.contains("contextwindowexceeded")
        || m.contains("context window")
        || m.contains("too many tokens")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_statuses() {
        let e = |s: u16, b: &str| AppError::from_response(StatusCode::from_u16(s).unwrap(), None, b).kind;
        assert_eq!(e(401, r#"{"error":{"message":"Invalid key"}}"#), ErrorKind::Unauthorized);
        assert_eq!(e(429, ""), ErrorKind::RateLimited);
        assert_eq!(e(404, ""), ErrorKind::ModelUnavailable);
        assert_eq!(
            e(400, r#"{"error":{"message":"This model's maximum context length is 8192 tokens."}}"#),
            ErrorKind::ContextLength
        );
        assert_eq!(e(400, r#"{"error":"bad temperature"}"#), ErrorKind::BadRequest);
        assert_eq!(e(502, "Bad Gateway"), ErrorKind::Server);
    }

    #[test]
    fn extracts_messages() {
        assert_eq!(extract_message(r#"{"error":{"message":"x"}}"#).as_deref(), Some("x"));
        assert_eq!(extract_message(r#"{"error":"y"}"#).as_deref(), Some("y"));
        assert_eq!(extract_message(r#"{"detail":"z"}"#).as_deref(), Some("z"));
        assert_eq!(extract_message("not json"), None);
    }
}
