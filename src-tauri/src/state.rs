use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use tokio_util::sync::CancellationToken;

use crate::config::{self, AppConfig};
use crate::credentials::{Credentials, FileStore, KeyringStore};
use crate::error::{AppError, ErrorKind};
use crate::gateway::Gateway;
use crate::models::{self, ModelInfo};

pub struct AppState {
    pub gateway: Gateway,
    pub credentials: Arc<Credentials>,
    /// App data directory: config cache and, only when there is no OS keychain, the key file.
    pub data_dir: PathBuf,
    /// Last loaded app config. `None` until the first `get_app_config`.
    pub config: RwLock<Option<AppConfig>>,
    /// Last `list_models` result, by id.
    pub models: RwLock<HashMap<String, ModelInfo>>,
    /// In-flight chat streams by request id.
    pub streams: Mutex<HashMap<String, CancellationToken>>,
}

impl AppState {
    pub fn new(gateway: Gateway, data_dir: PathBuf) -> Self {
        let credentials = Credentials::new(
            Box::new(KeyringStore),
            Box::new(FileStore::new(data_dir.join("gateway-key"))),
        );
        Self {
            gateway,
            credentials: Arc::new(credentials),
            data_dir,
            config: RwLock::new(None),
            models: RwLock::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
        }
    }

    /// The API key, reading the credential store on first use.
    pub async fn api_key(&self) -> Result<String, AppError> {
        if let Some(key) = self.credentials.cached_key() {
            return Ok(key);
        }
        let creds = self.credentials.clone();
        let loaded = tauri::async_runtime::spawn_blocking(move || creds.load()).await
            .map_err(|e| AppError::new(ErrorKind::Storage, e.to_string()))?;
        loaded.key.ok_or_else(|| AppError::new(ErrorKind::NoKey, "No API key set"))
    }

    pub fn config(&self) -> AppConfig {
        if let Some(c) = self.config.read().unwrap().as_ref() {
            return c.clone();
        }
        config::load_cached(&self.data_dir)
    }

    /// Model metadata from the last listing, or resolved from config alone if it wasn't listed.
    pub fn model(&self, id: &str) -> ModelInfo {
        if let Some(m) = self.models.read().unwrap().get(id) {
            return m.clone();
        }
        models::resolve(id, None, &self.config())
    }
}
