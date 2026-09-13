use std::collections::HashMap;
use std::sync::Mutex;

use tokio_util::sync::CancellationToken;

use crate::gateway::Gateway;

pub struct AppState {
    pub gateway: Gateway,
    /// Phase 0: held in memory only. Phase 1 moves this to the OS keychain.
    pub api_key: Mutex<Option<String>>,
    /// In-flight chat streams by request id.
    pub streams: Mutex<HashMap<String, CancellationToken>>,
}

impl AppState {
    pub fn new(gateway: Gateway) -> Self {
        Self { gateway, api_key: Mutex::new(None), streams: Mutex::new(HashMap::new()) }
    }

    pub fn api_key(&self) -> Option<String> {
        self.api_key.lock().unwrap().clone()
    }
}
