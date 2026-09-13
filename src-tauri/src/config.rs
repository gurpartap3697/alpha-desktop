//! Remote `app/config.json`: display and request metadata for models, defaults and the minimum
//! supported app version. Fetched from the gateway on startup; the last good copy is cached in the
//! app data directory so the app still works when the fetch fails.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::gateway::Gateway;

pub const CONFIG_PATH: &str = "/app/config.json";
pub const CACHE_FILE: &str = "app-config.json";
const MAX_CONFIG_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Defaults {
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub temperature: f64,
}

impl Default for Defaults {
    fn default() -> Self {
        Self { context_window: 8192, max_output_tokens: 2048, temperature: 0.7 }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ReasoningMeta {
    pub supported: bool,
    pub default_on: bool,
    /// Merged into the request body when reasoning is on / off.
    pub on_body: Option<Map<String, Value>>,
    pub off_body: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelMeta {
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub context_window: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f64>,
    pub reasoning: ReasoningMeta,
    pub vision: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub min_app_version: Option<String>,
    pub announcement: Option<String>,
    pub defaults: Defaults,
    pub models: BTreeMap<String, ModelMeta>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawConfig {
    min_app_version: Option<String>,
    announcement: Option<Value>,
    #[serde(default)]
    defaults: Defaults,
    #[serde(default)]
    models: BTreeMap<String, Value>,
}

impl AppConfig {
    /// The top-level shape must be valid. A malformed entry under `models` is skipped, so one typo
    /// only costs that model its metadata instead of breaking the whole config.
    pub fn parse(json: &str) -> Result<Self, String> {
        let raw: RawConfig = serde_json::from_str(json).map_err(|e| format!("Invalid app config: {e}"))?;
        let announcement = match raw.announcement {
            Some(Value::String(s)) if !s.trim().is_empty() => Some(s),
            Some(Value::Object(o)) => o.get("message").and_then(Value::as_str).map(str::to_owned),
            _ => None,
        };
        let models = raw.models.into_iter()
            .filter_map(|(id, v)| serde_json::from_value(v).ok().map(|m| (id, m)))
            .collect();
        Ok(Self { min_app_version: raw.min_app_version, announcement, defaults: raw.defaults, models })
    }

    /// True when this build is older than `minAppVersion`.
    pub fn update_required(&self, current: &str) -> bool {
        match (self.min_app_version.as_deref().and_then(parse_version), parse_version(current)) {
            (Some(min), Some(cur)) => cur < min,
            _ => false,
        }
    }
}

/// Accepts `1`, `1.2`, `1.2.3` and `v1.2.3-beta`; pre-release tags are compared as by semver.
fn parse_version(v: &str) -> Option<semver::Version> {
    let v = v.trim().trim_start_matches('v');
    let (core, rest) = match v.find(['-', '+']) {
        Some(i) => v.split_at(i),
        None => (v, ""),
    };
    let dots = core.matches('.').count();
    let padded = format!("{core}{}{rest}", ".0".repeat(2usize.saturating_sub(dots)));
    semver::Version::parse(&padded).ok()
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfigSource {
    Remote,
    Cache,
    Builtin,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigStatus {
    pub config: AppConfig,
    pub source: ConfigSource,
    /// Why the remote fetch failed, when `source` isn't `remote`.
    pub fetch_error: Option<String>,
    pub update_required: bool,
}

/// Fetch the remote config, falling back to the cache, then to built-in defaults.
pub async fn load(gateway: &Gateway, cache_dir: &Path) -> ConfigStatus {
    let cache = cache_dir.join(CACHE_FILE);
    let (config, source, fetch_error) = match fetch(gateway).await {
        Ok((config, raw)) => {
            if let Err(e) = write_cache(&cache, &raw) {
                eprintln!("alpha: couldn't cache app config: {e}");
            }
            (config, ConfigSource::Remote, None)
        }
        Err(fetch_err) => match read_cache(&cache) {
            Some(config) => (config, ConfigSource::Cache, Some(fetch_err)),
            None => (AppConfig::default(), ConfigSource::Builtin, Some(fetch_err)),
        },
    };
    let update_required = config.update_required(env!("CARGO_PKG_VERSION"));
    ConfigStatus { config, source, fetch_error, update_required }
}

/// Offline variant of [`load`] for when no fetch has happened yet.
pub fn load_cached(cache_dir: &Path) -> AppConfig {
    read_cache(&cache_dir.join(CACHE_FILE)).unwrap_or_default()
}

async fn fetch(gateway: &Gateway) -> Result<(AppConfig, String), String> {
    let resp = gateway.get_public(CONFIG_PATH).timeout(Duration::from_secs(10)).send().await
        .map_err(|e| crate::error::AppError::from(e).message)?;
    if !resp.status().is_success() {
        return Err(format!("{CONFIG_PATH} returned {}", resp.status()));
    }
    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        body.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
        if body.len() > MAX_CONFIG_BYTES {
            return Err(format!("{CONFIG_PATH} is larger than {MAX_CONFIG_BYTES} bytes"));
        }
    }
    let raw = String::from_utf8(body).map_err(|_| format!("{CONFIG_PATH} is not UTF-8"))?;
    Ok((AppConfig::parse(&raw)?, raw))
}

#[tauri::command]
pub async fn get_app_config(state: tauri::State<'_, crate::state::AppState>) -> Result<ConfigStatus, crate::error::AppError> {
    let status = load(&state.gateway, &state.data_dir).await;
    *state.config.write().unwrap() = Some(status.config.clone());
    Ok(status)
}

fn read_cache(path: &Path) -> Option<AppConfig> {
    AppConfig::parse(&std::fs::read_to_string(path).ok()?).ok()
}

fn write_cache(path: &Path, raw: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw)?;
    std::fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_repo_config() {
        let c = AppConfig::parse(include_str!("../../gateway/public/app/config.json")).unwrap();
        assert_eq!(c.defaults, Defaults::default());
        let qwen = &c.models["qwen"];
        assert!(qwen.reasoning.supported && qwen.reasoning.default_on);
        assert_eq!(qwen.reasoning.off_body.as_ref().unwrap()["chat_template_kwargs"]["enable_thinking"], false);
        assert!(!c.models["gemma"].reasoning.supported);
    }

    #[test]
    fn lenient_about_models_and_partial_defaults() {
        let c = AppConfig::parse(r#"{
            "defaults": { "contextWindow": 4096 },
            "announcement": { "message": "Maintenance at 6pm" },
            "models": { "good": { "displayName": "Good" }, "bad": { "contextWindow": "big" }, "bare": {} },
            "somethingNew": true
        }"#).unwrap();
        assert_eq!(c.defaults.context_window, 4096);
        assert_eq!(c.defaults.max_output_tokens, 2048);
        assert_eq!(c.announcement.as_deref(), Some("Maintenance at 6pm"));
        assert_eq!(c.models.keys().collect::<Vec<_>>(), ["bare", "good"]);
        assert!(AppConfig::parse("[]").is_err());
        assert!(AppConfig::parse("<html>").is_err());
    }

    #[test]
    fn version_gate() {
        let with = |min: &str| AppConfig { min_app_version: Some(min.into()), ..Default::default() };
        assert!(!with("0.1.0").update_required("0.1.0"));
        assert!(with("0.2.0").update_required("0.1.9"));
        assert!(with("0.10").update_required("0.9.0"));
        assert!(!with("1").update_required("1.0.1"));
        assert!(with("1.0.0").update_required("1.0.0-beta.1"));
        assert!(!with("not a version").update_required("0.1.0"));
        assert!(!AppConfig::default().update_required("0.1.0"));
    }

    #[test]
    fn cache_round_trip() {
        let dir = std::env::temp_dir().join(format!("alpha-config-test-{}", std::process::id()));
        assert_eq!(load_cached(&dir), AppConfig::default());
        write_cache(&dir.join(CACHE_FILE), r#"{"minAppVersion":"9.0.0"}"#).unwrap();
        assert_eq!(load_cached(&dir).min_app_version.as_deref(), Some("9.0.0"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
