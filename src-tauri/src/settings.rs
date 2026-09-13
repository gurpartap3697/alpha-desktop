//! App-wide settings: theme, defaults for new chats, and how long history is kept.
//!
//! Stored in the `settings` table with one row per field holding its JSON value, so adding a field
//! needs no migration and a damaged row only resets that one field.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};

use crate::db::{Db, Params};
use crate::error::{AppError, ErrorKind};
use crate::state::AppState;

pub const MAX_RETENTION_DAYS: u32 = 3650;
const MAX_OUTPUT_TOKENS: u32 = 1_000_000;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub theme: Theme,
    /// Model for new chats. `None`: continue with the most recently used model.
    pub default_model: Option<String>,
    /// System prompt for new chats.
    pub system_prompt: Option<String>,
    /// Parameters for new chats. `None` fields use the model's default.
    pub params: Params,
    /// Delete chats with no activity for this many days. `None`: keep them.
    pub retention_days: Option<u32>,
}

impl AppSettings {
    pub fn load(db: &Db) -> Result<Self, AppError> {
        Ok(Self::from_rows(&db.settings_rows()?))
    }

    /// Fields are read one row at a time; a row that doesn't parse or isn't valid is ignored.
    pub fn from_rows(rows: &[(String, String)]) -> Self {
        let mut fields = as_map(&Self::default());
        for (key, raw) in rows {
            let Ok(value) = serde_json::from_str::<Value>(raw) else { continue };
            let mut trial = fields.clone();
            trial.insert(key.clone(), value);
            if Self::from_map(trial.clone()).is_ok() {
                fields = trial;
            }
        }
        Self::from_map(fields).unwrap_or_default()
    }

    /// Apply a partial update (`{"theme": "dark"}`) and return the result, validated.
    pub fn patched(&self, patch: Map<String, Value>) -> Result<Self, AppError> {
        let mut fields = as_map(self);
        fields.extend(patch);
        Self::from_map(fields)
    }

    fn from_map(fields: Map<String, Value>) -> Result<Self, AppError> {
        let s: Self = serde_json::from_value(Value::Object(fields))
            .map_err(|e| AppError::new(ErrorKind::BadRequest, format!("Invalid setting: {e}")))?;
        s.validated()
    }

    fn validated(mut self) -> Result<Self, AppError> {
        let bad = |m: &str| Err(AppError::new(ErrorKind::BadRequest, m));
        if let Some(t) = self.params.temperature {
            if !(0.0..=2.0).contains(&t) {
                return bad("Temperature must be between 0 and 2");
            }
        }
        if let Some(n) = self.params.max_tokens {
            if n == 0 || n > MAX_OUTPUT_TOKENS {
                return bad("Maximum answer length must be a positive number of tokens");
            }
        }
        if let Some(d) = self.retention_days {
            if d == 0 || d > MAX_RETENTION_DAYS {
                return bad("Chats can be kept for 1 to 3650 days");
            }
        }
        self.default_model = self.default_model.map(|m| m.trim().to_owned()).filter(|m| !m.is_empty());
        self.system_prompt = self.system_prompt.filter(|p| !p.trim().is_empty());
        Ok(self)
    }

    pub fn rows(&self) -> Vec<(String, String)> {
        as_map(self).into_iter().map(|(k, v)| (k, v.to_string())).collect()
    }
}

fn as_map(s: &AppSettings) -> Map<String, Value> {
    match serde_json::to_value(s) {
        Ok(Value::Object(m)) => m,
        _ => unreachable!("settings serialize to an object"),
    }
}

/// Match the native window (title bar, and the webview's `prefers-color-scheme` where the OS ties
/// them together) to the chosen theme.
pub fn apply_theme(app: &AppHandle, theme: Theme) {
    let Some(window) = app.get_webview_window("main") else { return };
    let theme = match theme {
        Theme::System => None,
        Theme::Light => Some(tauri::Theme::Light),
        Theme::Dark => Some(tauri::Theme::Dark),
    };
    if let Err(e) = window.set_theme(theme) {
        eprintln!("settings: can't set window theme: {e}");
    }
}

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, AppError> {
    AppSettings::load(state.db()?)
}

#[tauri::command]
pub async fn settings_update(app: AppHandle, state: State<'_, AppState>, patch: Map<String, Value>)
    -> Result<AppSettings, AppError> {
    let db = state.db()?;
    let current = AppSettings::load(db)?;
    let next = current.patched(patch)?;
    db.put_settings(&next.rows())?;
    if next.theme != current.theme {
        apply_theme(&app, next.theme);
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patch(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn defaults_and_round_trip() {
        let db = Db::open_in_memory();
        assert_eq!(AppSettings::load(&db).unwrap(), AppSettings::default());

        let s = AppSettings::default().patched(patch(json!({
            "theme": "dark",
            "defaultModel": " qwen ",
            "systemPrompt": "Be brief.",
            "params": { "temperature": 0.2, "maxTokens": 512, "reasoning": false },
            "retentionDays": 30,
        }))).unwrap();
        assert_eq!(s.default_model.as_deref(), Some("qwen"));
        db.put_settings(&s.rows()).unwrap();
        assert_eq!(AppSettings::load(&db).unwrap(), s);

        // Clearing works, and blank text counts as unset.
        let cleared = s.patched(patch(json!({ "retentionDays": null, "systemPrompt": "  ", "defaultModel": "" }))).unwrap();
        assert_eq!((cleared.retention_days, cleared.system_prompt, cleared.default_model), (None, None, None));
        assert_eq!(cleared.theme, Theme::Dark, "fields not in the patch are unchanged");
    }

    #[test]
    fn rejects_invalid_values() {
        let s = AppSettings::default();
        for bad in [
            json!({ "theme": "sepia" }),
            json!({ "params": { "temperature": 2.5 } }),
            json!({ "params": { "maxTokens": 0 } }),
            json!({ "retentionDays": 0 }),
            json!({ "retentionDays": 5000 }),
            json!({ "retentionDays": -1 }),
        ] {
            let e = s.patched(patch(bad.clone())).expect_err(&bad.to_string());
            assert_eq!(e.kind, ErrorKind::BadRequest);
        }
    }

    #[test]
    fn a_damaged_row_only_resets_its_field() {
        let rows = [
            ("theme".to_string(), "\"dark\"".to_string()),
            ("retentionDays".to_string(), "not json".to_string()),
            ("params".to_string(), r#"{"temperature": 9}"#.to_string()),
            ("defaultModel".to_string(), "\"gemma\"".to_string()),
            ("fromTheFuture".to_string(), "true".to_string()),
        ];
        let s = AppSettings::from_rows(&rows);
        assert_eq!(s.theme, Theme::Dark);
        assert_eq!(s.default_model.as_deref(), Some("gemma"));
        assert_eq!((s.retention_days, s.params), (None, Params::default()));
    }
}
