//! Per-user gateway API keys (LiteLLM virtual keys). Everything else asks `AppState::api_key` for
//! the bearer token, so an OIDC sign-in can replace this module later without touching callers.

use serde::Serialize;
use tauri::State;

use crate::credentials::StorageKind;
use crate::error::{AppError, ErrorKind};
use crate::models;
use crate::state::AppState;

const MAX_KEY_LEN: usize = 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub has_key: bool,
    /// Where the key is kept. `file` means no OS keychain was available.
    pub storage: Option<StorageKind>,
    /// Reading the OS keychain failed (e.g. it's locked or access was denied).
    pub storage_error: Option<String>,
    pub gateway_url: String,
    pub app_version: &'static str,
}

fn status(state: &AppState, loaded: crate::credentials::Loaded) -> AuthStatus {
    AuthStatus {
        has_key: loaded.key.is_some(),
        storage: loaded.storage,
        storage_error: loaded.error,
        gateway_url: state.gateway.base_url().to_owned(),
        app_version: env!("CARGO_PKG_VERSION"),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::new(ErrorKind::Storage, e.to_string()))
}

pub fn validate_format(key: &str) -> Result<(), AppError> {
    if key.is_empty() || key.len() > MAX_KEY_LEN || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::new(ErrorKind::Unauthorized, "That doesn't look like a valid key"));
    }
    Ok(())
}

/// Reads the credential store; no network.
#[tauri::command]
pub async fn auth_status(state: State<'_, AppState>) -> Result<AuthStatus, AppError> {
    let creds = state.credentials.clone();
    let loaded = blocking(move || creds.load()).await?;
    Ok(status(&state, loaded))
}

/// Check the key against the gateway, then store it.
#[tauri::command]
pub async fn auth_set_key(state: State<'_, AppState>, key: String) -> Result<AuthStatus, AppError> {
    let key = key.trim().to_owned();
    validate_format(&key)?;
    models::fetch(&state.gateway, &key).await?;

    let creds = state.credentials.clone();
    let saved = key.clone();
    blocking(move || creds.save(&saved)).await?.map_err(|e| AppError::new(ErrorKind::Storage, e))?;
    let creds = state.credentials.clone();
    let loaded = blocking(move || creds.load()).await?;
    Ok(status(&state, loaded))
}

/// Sign out: forget the key everywhere it is stored.
#[tauri::command]
pub async fn auth_clear(state: State<'_, AppState>) -> Result<(), AppError> {
    let creds = state.credentials.clone();
    state.models.write().unwrap().clear();
    blocking(move || creds.clear()).await?.map_err(|e| AppError::new(ErrorKind::Storage, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_format() {
        assert!(validate_format("sk-abc123").is_ok());
        assert!(validate_format("").is_err());
        assert!(validate_format("sk abc").is_err());
        assert!(validate_format("sk-\u{7}").is_err());
        assert!(validate_format(&"k".repeat(MAX_KEY_LEN + 1)).is_err());
    }
}
