//! Model catalogue: what the gateway serves (`/v1/models`), described by the app config.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config::AppConfig;
use crate::error::{AppError, ErrorKind};
use crate::gateway::{check, Gateway};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningInfo {
    /// The model can switch reasoning on and off (config has `onBody` / `offBody`).
    pub supported: bool,
    pub default_on: bool,
    #[serde(skip)]
    pub on_body: Option<Map<String, Value>>,
    #[serde(skip)]
    pub off_body: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub temperature: f64,
    pub reasoning: ReasoningInfo,
    pub vision: bool,
    /// Has an entry in the app config (otherwise everything above is a default).
    pub configured: bool,
}

impl ModelInfo {
    /// Extra request body for the chosen reasoning state. `None` means "use the model's default".
    pub fn reasoning_body(&self, on: Option<bool>) -> Option<&Map<String, Value>> {
        if !self.reasoning.supported {
            return None;
        }
        match on.unwrap_or(self.reasoning.default_on) {
            true => self.reasoning.on_body.as_ref(),
            false => self.reasoning.off_body.as_ref(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct GatewayModel {
    pub id: String,
    /// vLLM reports this; LiteLLM doesn't.
    pub max_model_len: Option<u32>,
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<GatewayModel>,
}

pub async fn fetch(gateway: &Gateway, key: &str) -> Result<Vec<GatewayModel>, AppError> {
    let req = gateway.get("/v1/models", key).timeout(Duration::from_secs(20));
    let resp = check(req.send().await?).await?;
    let list: ModelList = resp.json().await
        .map_err(|e| AppError::new(ErrorKind::Protocol, format!("Unexpected /v1/models response: {e}")))?;
    Ok(list.data)
}

/// Describe one model: config entry first, then what the server reported, then config defaults.
pub fn resolve(id: &str, max_model_len: Option<u32>, config: &AppConfig) -> ModelInfo {
    let meta = config.models.get(id);
    let d = &config.defaults;
    let context_window = meta.and_then(|m| m.context_window).or(max_model_len).unwrap_or(d.context_window).max(1);
    // Never let the output reservation take more than half the window.
    let max_output_tokens = meta.and_then(|m| m.max_output_tokens).unwrap_or(d.max_output_tokens)
        .clamp(1, (context_window / 2).max(1));
    let reasoning = meta.map(|m| &m.reasoning);
    ModelInfo {
        id: id.to_owned(),
        display_name: meta.and_then(|m| m.display_name.clone()).unwrap_or_else(|| id.to_owned()),
        description: meta.and_then(|m| m.description.clone()),
        context_window,
        max_output_tokens,
        temperature: meta.and_then(|m| m.temperature).unwrap_or(d.temperature),
        reasoning: ReasoningInfo {
            supported: reasoning.is_some_and(|r| r.supported && (r.on_body.is_some() || r.off_body.is_some())),
            default_on: reasoning.is_some_and(|r| r.default_on),
            on_body: reasoning.and_then(|r| r.on_body.clone()),
            off_body: reasoning.and_then(|r| r.off_body.clone()),
        },
        vision: meta.is_some_and(|m| m.vision),
        configured: meta.is_some(),
    }
}

/// Only models the gateway actually serves are listed, sorted by display name.
pub fn merge(served: &[GatewayModel], config: &AppConfig) -> Vec<ModelInfo> {
    let mut out: Vec<ModelInfo> = served.iter().map(|m| resolve(&m.id, m.max_model_len, config)).collect();
    out.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()).then(a.id.cmp(&b.id)));
    out.dedup_by(|a, b| a.id == b.id);
    out
}

#[tauri::command]
pub async fn list_models(state: tauri::State<'_, crate::state::AppState>) -> Result<Vec<ModelInfo>, AppError> {
    let key = state.api_key().await?;
    let models = merge(&fetch(&state.gateway, &key).await?, &state.config());
    *state.models.write().unwrap() = models.iter().map(|m| (m.id.clone(), m.clone())).collect();
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> AppConfig {
        AppConfig::parse(include_str!("../../gateway/public/app/config.json")).unwrap()
    }

    fn served(ids: &[(&str, Option<u32>)]) -> Vec<GatewayModel> {
        ids.iter().map(|(id, len)| GatewayModel { id: (*id).into(), max_model_len: *len }).collect()
    }

    #[test]
    fn merges_config_with_served_models() {
        let models = merge(&served(&[("qwen", None), ("unknown/Model-7B", Some(40960)), ("gemma", None)]), &config());
        let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
        // nemotron is configured but not served, so it's absent.
        assert_eq!(ids, ["gemma", "qwen", "unknown/Model-7B"]);

        let qwen = &models[1];
        assert_eq!((qwen.display_name.as_str(), qwen.context_window, qwen.max_output_tokens), ("Qwen", 32768, 8192));
        assert!(qwen.configured && qwen.reasoning.supported && qwen.reasoning.default_on);

        let unknown = &models[2];
        assert!(!unknown.configured && !unknown.reasoning.supported);
        assert_eq!(unknown.display_name, "unknown/Model-7B");
        assert_eq!(unknown.context_window, 40960, "falls back to the server's max_model_len");
        assert_eq!(unknown.max_output_tokens, 2048);
        assert_eq!(unknown.temperature, 0.7);
    }

    #[test]
    fn reasoning_body_follows_toggle_and_default() {
        let qwen = resolve("qwen", None, &config());
        let flag = |b: Option<&Map<String, Value>>| b.map(|m| m["chat_template_kwargs"]["enable_thinking"].clone());
        assert_eq!(flag(qwen.reasoning_body(None)), Some(Value::Bool(true)));
        assert_eq!(flag(qwen.reasoning_body(Some(false))), Some(Value::Bool(false)));
        assert_eq!(resolve("gemma", None, &config()).reasoning_body(Some(true)), None);
    }

    #[test]
    fn output_reservation_is_capped() {
        let mut c = AppConfig::default();
        c.defaults.context_window = 2048;
        c.defaults.max_output_tokens = 4096;
        assert_eq!(resolve("x", None, &c).max_output_tokens, 1024);
    }

    #[test]
    fn serialized_shape_hides_request_bodies() {
        let v = serde_json::to_value(resolve("qwen", None, &config())).unwrap();
        assert_eq!(v["reasoning"], serde_json::json!({ "supported": true, "defaultOn": true }));
        assert_eq!(v["displayName"], "Qwen");
    }
}
