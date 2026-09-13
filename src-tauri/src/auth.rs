use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, ErrorKind};
use crate::gateway::{check, Gateway};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub has_key: bool,
    pub gateway_url: String,
    pub app_version: &'static str,
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

async fn fetch_models(gateway: &Gateway, key: &str) -> Result<Vec<String>, AppError> {
    let resp = check(gateway.get("/v1/models", key).send().await?).await?;
    let list: ModelList = resp.json().await
        .map_err(|e| AppError::new(ErrorKind::Protocol, format!("Unexpected /v1/models response: {e}")))?;
    let mut ids: Vec<String> = list.data.into_iter().map(|m| m.id).collect();
    ids.sort();
    Ok(ids)
}

/// Validate the key against the gateway, then keep it.
#[tauri::command]
pub async fn auth_set_key(state: State<'_, AppState>, key: String) -> Result<(), AppError> {
    let key = key.trim().to_owned();
    if key.is_empty() || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::new(ErrorKind::Unauthorized, "That doesn't look like a valid key"));
    }
    fetch_models(&state.gateway, &key).await?;
    *state.api_key.lock().unwrap() = Some(key);
    Ok(())
}

#[tauri::command]
pub fn auth_status(state: State<'_, AppState>) -> AuthStatus {
    AuthStatus {
        has_key: state.api_key().is_some(),
        gateway_url: state.gateway.base_url().to_owned(),
        app_version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
pub fn auth_clear(state: State<'_, AppState>) {
    *state.api_key.lock().unwrap() = None;
}

/// Model ids from the gateway. Phase 1 merges these with `app-config.json` metadata.
#[tauri::command]
pub async fn list_models(state: State<'_, AppState>) -> Result<Vec<String>, AppError> {
    let key = state.api_key().ok_or_else(|| AppError::new(ErrorKind::NoKey, "No API key set"))?;
    fetch_models(&state.gateway, &key).await
}
