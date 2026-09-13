//! Commands for the conversation list (open, search, rename, delete, titles, export) and for
//! history as a whole (auto-delete, delete all).

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::db::{now_ms, Conversation, ConversationSummary, Params};
use crate::error::{AppError, ErrorKind};
use crate::settings::AppSettings;
use crate::state::{AppState, HISTORY_FILE};
use crate::titles;

#[tauri::command]
pub async fn conversations_list(state: State<'_, AppState>, query: Option<String>)
    -> Result<Vec<ConversationSummary>, AppError> {
    state.db()?.list(query.as_deref().unwrap_or(""))
}

#[tauri::command]
pub async fn conversation_get(state: State<'_, AppState>, id: String) -> Result<Conversation, AppError> {
    state.db()?.get(&id)
}

#[tauri::command]
pub async fn conversation_update(
    state: State<'_, AppState>,
    id: String,
    model: String,
    system_prompt: Option<String>,
    params: Params,
) -> Result<(), AppError> {
    state.db()?.update_settings(&id, &model, system_prompt.as_deref(), &params)
}

#[tauri::command]
pub async fn conversation_rename(state: State<'_, AppState>, id: String, title: String)
    -> Result<ConversationSummary, AppError> {
    state.db()?.rename(&id, &title)
}

#[tauri::command]
pub async fn conversation_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.cancel_conversation(&id);
    state.db()?.delete(&id)
}

/// Give the conversation a generated title if it's still waiting for one and has an answer.
/// Returns the conversation with its title, which is unchanged when there was nothing to do.
#[tauri::command]
pub async fn conversation_generate_title(state: State<'_, AppState>, id: String)
    -> Result<ConversationSummary, AppError> {
    let db = state.db()?;
    let Some(input) = db.title_input(&id)? else {
        return db.summary(&id);
    };
    let generated = match state.api_key().await {
        Ok(key) => {
            let model = state.model(&input.model_id);
            titles::generate(&state.gateway, &key, &model, &input).await
                .inspect_err(|e| eprintln!("title generation failed: {e}"))
                .ok()
                .flatten()
        }
        Err(_) => None,
    };
    db.resolve_title(&id, generated.as_deref())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryInfo {
    /// The database file, for "what's stored where".
    pub path: String,
    pub conversations: u64,
    /// With `inactive_days`: how many chats have had no activity for that long.
    pub inactive: Option<u64>,
}

#[tauri::command]
pub async fn history_info(state: State<'_, AppState>, inactive_days: Option<u32>) -> Result<HistoryInfo, AppError> {
    let db = state.db()?;
    Ok(HistoryInfo {
        path: state.data_dir.join(HISTORY_FILE).display().to_string(),
        conversations: db.count()?,
        inactive: inactive_days.map(|d| db.count_inactive(retention_cutoff(d))).transpose()?,
    })
}

/// Apply the auto-delete setting. Chats in `keep` (the one on screen) and chats still answering are
/// left alone. Returns the ids deleted.
#[tauri::command]
pub async fn history_prune(state: State<'_, AppState>, keep: Vec<String>) -> Result<Vec<String>, AppError> {
    prune(&state, keep)
}

pub fn prune(state: &AppState, mut keep: Vec<String>) -> Result<Vec<String>, AppError> {
    let db = state.db()?;
    let Some(days) = AppSettings::load(db)?.retention_days else { return Ok(Vec::new()) };
    keep.extend(state.streams.lock().unwrap().values().filter_map(|s| s.conversation_id.clone()));
    let deleted = db.delete_inactive(retention_cutoff(days), &keep)?;
    if !deleted.is_empty() {
        eprintln!("history: auto-deleted {} chat(s) inactive for {days} days", deleted.len());
    }
    Ok(deleted)
}

fn retention_cutoff(days: u32) -> i64 {
    now_ms() - i64::from(days) * 86_400_000
}

#[tauri::command]
pub async fn history_delete_all(state: State<'_, AppState>) -> Result<u64, AppError> {
    for s in state.streams.lock().unwrap().values() {
        s.token.cancel();
    }
    state.db()?.delete_all()
}

/// Show the history file in the system file manager.
#[tauri::command]
pub async fn history_reveal(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError> {
    let path = state.data_dir.join(HISTORY_FILE);
    app.opener().reveal_item_in_dir(&path)
        .map_err(|e| AppError::new(ErrorKind::Storage, format!("Couldn't show {}: {e}", path.display())))
}

/// Ask where to save, then write the Markdown there. `None` if the user cancelled.
/// The file is written by the Rust side so the webview needs no file-system access.
#[tauri::command]
pub async fn save_markdown(app: AppHandle, suggested_name: String, content: String)
    -> Result<Option<String>, AppError> {
    let name = file_name(&suggested_name);
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().add_filter("Markdown", &["md"]).set_file_name(name).blocking_save_file()
    })
    .await
    .map_err(|e| AppError::new(ErrorKind::Storage, e.to_string()))?;
    let Some(chosen) = chosen else { return Ok(None) };
    let mut path: PathBuf = chosen.into_path()
        .map_err(|e| AppError::new(ErrorKind::Storage, format!("Unsupported location: {e}")))?;
    // Some Linux file choosers don't add the filter's extension.
    if path.extension().is_none() {
        path.set_extension("md");
    }
    let shown = path.display().to_string();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, content))
        .await
        .map_err(|e| AppError::new(ErrorKind::Storage, e.to_string()))?
        .map_err(|e| AppError::new(ErrorKind::Storage, format!("Couldn't write {shown}: {e}")))?;
    Ok(Some(shown))
}

/// A portable file name: no path separators or characters Windows rejects.
fn file_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if c.is_control() || r#"/\:*?"<>|"#.contains(c) { ' ' } else { c })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned: String = cleaned.trim_matches(['.', ' ']).chars().take(80).collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']);
    format!("{}.md", if cleaned.is_empty() { "Chat" } else { cleaned })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names() {
        assert_eq!(file_name("Rust: traits vs. generics?"), "Rust traits vs. generics.md");
        assert_eq!(file_name("../../etc/passwd"), "etc passwd.md");
        assert_eq!(file_name("  ...  "), "Chat.md");
        assert_eq!(file_name("a\nb\tc"), "a b c.md");
    }
}
