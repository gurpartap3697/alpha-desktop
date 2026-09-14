use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

/// Error categories the UI designs a state for (see "Error states" in plan.md).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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
    /// The OS credential store (or the fallback file) failed.
    Storage,
    /// Chat history (SQLite) couldn't be read or written.
    Database,
    /// A conversation or message that no longer exists.
    NotFound,
    /// The app was closed while the answer was streaming.
    Interrupted,
    /// Checking, downloading, verifying or installing an app update failed.
    Update,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
            // LiteLLM answers a valid key without access to the model with 401 too.
            401 | 403 if message.to_ascii_lowercase().contains("not allowed to access model") => ErrorKind::ModelUnavailable,
            401 | 403 => ErrorKind::Unauthorized,
            429 => ErrorKind::RateLimited,
            404 => ErrorKind::ModelUnavailable,
            _ if is_context_error(&message) => ErrorKind::ContextLength,
            // LiteLLM: a model id it doesn't route.
            400 if message.contains("Invalid model name") => ErrorKind::ModelUnavailable,
            400 | 413 | 422 => ErrorKind::BadRequest,
            // LiteLLM reports a failure of one model's backend (down, unreachable, crashed) as a 5xx
            // naming the model group; other models may still work.
            500..=599 if is_model_backend_error(&message) => ErrorKind::ModelUnavailable,
            _ => ErrorKind::Server,
        };
        Self { kind, message, retry_after }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::QueryReturnedNoRows => Self::new(ErrorKind::NotFound, "Not found"),
            e => Self::new(ErrorKind::Database, error_chain(&e)),
        }
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

fn is_model_backend_error(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("model group=")
        || m.contains("cannot connect to host")
        || m.contains("connection refused")
        || m.contains("apiconnectionerror")
        || m.contains("serviceunavailableerror")
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
        assert_eq!(
            e(401, r#"{"error":{"message":"API Key not allowed to access model. This token can only access models=['gemma']. Tried to access qwen","type":"auth_error","code":"401"}}"#),
            ErrorKind::ModelUnavailable
        );
        assert_eq!(e(429, ""), ErrorKind::RateLimited);
        assert_eq!(e(404, ""), ErrorKind::ModelUnavailable);
        assert_eq!(
            e(400, r#"{"error":{"message":"This model's maximum context length is 8192 tokens."}}"#),
            ErrorKind::ContextLength
        );
        assert_eq!(e(400, r#"{"error":"bad temperature"}"#), ErrorKind::BadRequest);
        assert_eq!(e(502, "Bad Gateway"), ErrorKind::Server);
        assert_eq!(e(500, r#"{"error":{"message":"Internal Server Error"}}"#), ErrorKind::Server);
    }

    /// Bodies captured from LiteLLM v1.100 in front of vLLM.
    #[test]
    fn classifies_litellm_errors() {
        let e = |s: u16, b: &str| AppError::from_response(StatusCode::from_u16(s).unwrap(), None, b).kind;
        assert_eq!(
            e(500, r#"{"error":{"message":"litellm.InternalServerError: InternalServerError: Hosted_vllmException - Cannot connect to host localhost:8000 ssl:<ssl.SSLContext object at 0xffff90be6c10> [Connect call failed ('127.0.0.1', 8000)]. Received Model Group=qwen\nAvailable Model Group Fallbacks=None","type":null,"param":null,"code":"500"}}"#),
            ErrorKind::ModelUnavailable
        );
        assert_eq!(
            e(400, r#"{"error":{"message":"/chat/completions: Invalid model name passed in model=no-such-model. Call `/v1/models` to view available models for your key.","type":"invalid_request_error","param":"model","code":"400"}}"#),
            ErrorKind::ModelUnavailable
        );
        assert_eq!(
            e(400, r#"{"error":{"message":"litellm.ContextWindowExceededError: litellm.BadRequestError: ContextWindowExceededError: Hosted_vllmException - This model's maximum context length is 40960 tokens. Received Model Group=qwen","code":"400"}}"#),
            ErrorKind::ContextLength
        );
    }

    #[test]
    fn extracts_messages() {
        assert_eq!(extract_message(r#"{"error":{"message":"x"}}"#).as_deref(), Some("x"));
        assert_eq!(extract_message(r#"{"error":"y"}"#).as_deref(), Some("y"));
        assert_eq!(extract_message(r#"{"detail":"z"}"#).as_deref(), Some("z"));
        assert_eq!(extract_message("not json"), None);
    }
}
