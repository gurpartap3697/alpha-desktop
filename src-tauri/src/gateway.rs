use std::time::Duration;

use reqwest::{header, Client, RequestBuilder, Response};

use crate::error::AppError;

/// Gateway base URL, fixed at compile time: `ALPH_GATEWAY_URL=https://llm.example.org npm run tauri build`.
/// Every request is built from this base plus a fixed path and redirects are disabled,
/// so the app cannot be made to send the API key to any other host.
pub const GATEWAY_URL: &str = match option_env!("ALPH_GATEWAY_URL") {
    Some(url) => url,
    None => "http://localhost:4000",
};

pub struct Gateway {
    client: Client,
    base: String,
}

impl Gateway {
    pub fn new() -> Result<Self, reqwest::Error> {
        Self::with_base(GATEWAY_URL)
    }

    pub(crate) fn with_base(base: &str) -> Result<Self, reqwest::Error> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            // Max silence between bytes. Generous: a reasoning model under load can
            // take a while before the first token.
            .read_timeout(Duration::from_secs(180))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("alph-desktop/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self { client, base: base.trim_end_matches('/').to_owned() })
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// Unauthenticated GET, for static files such as the app config.
    pub fn get_public(&self, path: &str) -> RequestBuilder {
        self.client.get(format!("{}{}", self.base, path))
    }

    pub fn get(&self, path: &str, key: &str) -> RequestBuilder {
        self.client.get(format!("{}{}", self.base, path)).bearer_auth(key)
    }

    pub fn post(&self, path: &str, key: &str) -> RequestBuilder {
        self.client.post(format!("{}{}", self.base, path)).bearer_auth(key)
    }
}

/// Turn a non-2xx response into an `AppError`; pass 2xx through.
pub async fn check(resp: Response) -> Result<Response, AppError> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let retry_after = resp
        .headers()
        .get(header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    let body = resp.text().await.unwrap_or_default();
    Err(AppError::from_response(status, retry_after, &body))
}
