//! Auto-update. The gateway serves the manifest at `/app/updates/latest.json` next to the packages
//! (see `gateway/scripts/publish_release.py`). Packages are verified against the updater public key
//! in the build's config before they are installed, and are only downloaded from the gateway host.
//!
//! The flow is split so the UI can download in the background and install when the user is ready:
//! `update_check` → `update_download` → `update_install` (which restarts the app).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Url;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{AppError, ErrorKind};
use crate::gateway::GATEWAY_URL;
use crate::state::AppState;

pub const MANIFEST_PATH: &str = "/app/updates/latest.json";
/// How long installing waits for streaming answers to stop and save.
const STREAM_STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdateStatus {
    /// This build can't update itself (no updater key, development build, plain-HTTP server).
    Disabled,
    /// Nothing newer is published for this system.
    UpToDate,
    Available,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub status: UpdateStatus,
    pub current_version: String,
    /// The published version, when `available`.
    pub version: Option<String>,
    /// Release notes from the manifest.
    pub notes: Option<String>,
    /// The package is downloaded and verified, ready for `update_install`.
    pub downloaded: bool,
    /// Why the status is `disabled`, or why nothing was found.
    pub reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum DownloadEvent {
    Progress { downloaded: u64, total: Option<u64> },
    Finished,
}

struct Pending {
    update: Update,
    bytes: Option<Vec<u8>>,
}

/// The update found by the last check, and its package once downloaded.
#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Pending>>,
    /// Held while downloading, so two downloads don't run at once.
    downloading: tokio::sync::Mutex<()>,
}

fn configured_pubkey(app: &AppHandle) -> Option<String> {
    let key = app.config().plugins.0.get("updater")?.get("pubkey")?.as_str()?.trim();
    (!key.is_empty()).then(|| key.to_owned())
}

pub fn manifest_url(base: &str) -> Result<Url, String> {
    Url::parse(&format!("{}{MANIFEST_PATH}", base.trim_end_matches('/'))).map_err(|e| format!("Invalid gateway URL: {e}"))
}

/// Same scheme, host and port.
pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

fn map_error(e: tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Reqwest(e) => {
            let mut err = AppError::from(e);
            // A body that couldn't be read or decoded isn't a chat answer that dropped.
            if err.kind == ErrorKind::StreamDropped {
                err.kind = ErrorKind::Update;
            }
            err
        }
        E::Network(m) => AppError::new(ErrorKind::Unreachable, m),
        E::ReleaseNotFound | E::Serialization(_) => {
            AppError::new(ErrorKind::Update, "The update server's manifest couldn't be read")
        }
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => AppError::new(
            ErrorKind::Update,
            format!("The downloaded update isn't signed with Alpha's update key, so it wasn't installed ({e})"),
        ),
        E::AuthenticationFailed => AppError::new(ErrorKind::Update, "Installing the update needs your password"),
        e => AppError::new(ErrorKind::Update, e.to_string()),
    }
}

fn info(status: UpdateStatus, reason: Option<String>) -> UpdateInfo {
    UpdateInfo {
        status,
        current_version: env!("CARGO_PKG_VERSION").to_owned(),
        version: None,
        notes: None,
        downloaded: false,
        reason,
    }
}

/// Ask the gateway whether a newer version is published.
#[tauri::command]
pub async fn update_check(app: AppHandle, updates: State<'_, Updates>) -> Result<UpdateInfo, AppError> {
    if cfg!(debug_assertions) {
        return Ok(info(UpdateStatus::Disabled, Some("Development builds don't update themselves".into())));
    }
    if configured_pubkey(&app).is_none() {
        return Ok(info(UpdateStatus::Disabled, Some("This build has no update key".into())));
    }
    let manifest = manifest_url(GATEWAY_URL).map_err(|m| AppError::new(ErrorKind::Update, m))?;
    let gateway = manifest.clone();
    let builder = match app.updater_builder().endpoints(vec![manifest]) {
        Ok(b) => b,
        Err(tauri_plugin_updater::Error::InsecureTransportProtocol) => {
            return Ok(info(UpdateStatus::Disabled, Some("Updates need an HTTPS model server".into())));
        }
        Err(e) => return Err(map_error(e)),
    };
    let updater = builder
        .timeout(Duration::from_secs(30))
        // Like the gateway client: no redirects, so nothing is fetched from another host.
        .configure_client(|c| c.redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(10)))
        .build()
        .map_err(map_error)?;

    let update = match updater.check().await {
        Ok(u) => u,
        // No manifest published yet (404), or none for this kind of install.
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => {
            *updates.pending.lock().unwrap() = None;
            return Ok(info(UpdateStatus::UpToDate, Some("No update has been published".into())));
        }
        Err(tauri_plugin_updater::Error::TargetsNotFound(targets)) => {
            *updates.pending.lock().unwrap() = None;
            return Ok(info(UpdateStatus::UpToDate, Some(format!("No update is published for this system ({})", targets.join(", ")))));
        }
        Err(e) => return Err(map_error(e)),
    };
    let Some(update) = update else {
        *updates.pending.lock().unwrap() = None;
        return Ok(info(UpdateStatus::UpToDate, None));
    };
    if !same_origin(&update.download_url, &gateway) {
        return Err(AppError::new(
            ErrorKind::Update,
            format!("The update is hosted on {}, not on the model server, so it wasn't downloaded", update.download_url),
        ));
    }

    let mut pending = updates.pending.lock().unwrap();
    // Keep a package already downloaded for this same version.
    let bytes = pending.take().filter(|p| p.update.version == update.version && p.update.signature == update.signature)
        .and_then(|p| p.bytes);
    let result = UpdateInfo {
        status: UpdateStatus::Available,
        current_version: update.current_version.clone(),
        version: Some(update.version.clone()),
        notes: update.body.clone().filter(|n| !n.trim().is_empty()),
        downloaded: bytes.is_some(),
        reason: None,
    };
    *pending = Some(Pending { update, bytes });
    Ok(result)
}

/// Download and verify the update found by the last check. Progress is reported about 10 times a second.
#[tauri::command]
pub async fn update_download(updates: State<'_, Updates>, on_event: Channel<DownloadEvent>) -> Result<(), AppError> {
    let _downloading = updates.downloading.lock().await;
    let update = match updates.pending.lock().unwrap().as_ref() {
        Some(Pending { bytes: Some(_), .. }) => {
            let _ = on_event.send(DownloadEvent::Finished);
            return Ok(());
        }
        Some(p) => p.update.clone(),
        None => return Err(AppError::new(ErrorKind::NotFound, "No update to download. Check for updates first")),
    };

    let mut downloaded = 0u64;
    let mut last_sent: Option<Instant> = None;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if last_sent.is_none_or(|t| t.elapsed() >= Duration::from_millis(100)) {
                    last_sent = Some(Instant::now());
                    let _ = on_event.send(DownloadEvent::Progress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(map_error)?;

    let mut pending = updates.pending.lock().unwrap();
    match pending.as_mut() {
        // A newer check may have replaced the update meanwhile; then this download is stale.
        Some(p) if p.update.version == update.version && p.update.signature == update.signature => p.bytes = Some(bytes),
        _ => return Err(AppError::new(ErrorKind::Update, "A newer update was found while downloading. Try again")),
    }
    let _ = on_event.send(DownloadEvent::Finished);
    Ok(())
}

/// Stop streaming answers (their partial text is saved), install the downloaded update and restart.
/// On Windows the installer takes over and reopens the app.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: State<'_, AppState>,
    updates: State<'_, Updates>,
) -> Result<(), AppError> {
    let (update, bytes) = {
        let pending = updates.pending.lock().unwrap();
        match pending.as_ref() {
            Some(Pending { update, bytes: Some(bytes) }) => (update.clone(), bytes.clone()),
            _ => return Err(AppError::new(ErrorKind::NotFound, "The update hasn't been downloaded yet")),
        }
    };

    for s in state.streams.lock().unwrap().values() {
        s.token.cancel();
    }
    let deadline = Instant::now() + STREAM_STOP_TIMEOUT;
    while !state.streams.lock().unwrap().is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| AppError::new(ErrorKind::Update, e.to_string()))?
        .map_err(map_error)?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_on_the_gateway() {
        assert_eq!(manifest_url("https://llm.example.org/").unwrap().as_str(), "https://llm.example.org/app/updates/latest.json");
        assert_eq!(manifest_url("http://localhost:8080").unwrap().as_str(), "http://localhost:8080/app/updates/latest.json");
        assert!(manifest_url("not a url").is_err());
    }

    #[test]
    fn origin_check() {
        let gw = Url::parse("https://llm.example.org/app/updates/latest.json").unwrap();
        let ok = |u: &str| same_origin(&Url::parse(u).unwrap(), &gw);
        assert!(ok("https://llm.example.org/app/updates/0.2.0/Alpha.app.tar.gz"));
        assert!(ok("https://llm.example.org:443/x"));
        assert!(!ok("http://llm.example.org/x"));
        assert!(!ok("https://llm.example.org:8443/x"));
        assert!(!ok("https://github.com/org/alpha/releases/download/v0.2.0/Alpha.app.tar.gz"));
        assert!(!ok("https://llm.example.org.evil.test/x"));
    }

    /// The updater compares against the version in tauri.conf.json, `minAppVersion` against Cargo's,
    /// and the UI shows package.json's. They must be the same (`npm run set-version -- x.y.z` sets all of them).
    #[test]
    fn versions_agree() {
        let version = |json: &str| serde_json::from_str::<serde_json::Value>(json).unwrap()["version"].as_str().unwrap().to_owned();
        assert_eq!(version(include_str!("../tauri.conf.json")), env!("CARGO_PKG_VERSION"));
        assert_eq!(version(include_str!("../../package.json")), env!("CARGO_PKG_VERSION"));
    }
}
