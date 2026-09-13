mod auth;
mod chat;
mod config;
mod context;
mod credentials;
mod db;
mod error;
mod gateway;
mod history;
mod models;
mod settings;
mod sse;
mod state;
mod titles;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let gateway = gateway::Gateway::new()?;
            let data_dir = app.path().app_data_dir()?;
            let state = state::AppState::new(gateway, data_dir);
            if let Ok(db) = state.db() {
                match settings::AppSettings::load(db) {
                    Ok(s) => settings::apply_theme(app.handle(), s.theme),
                    Err(e) => eprintln!("settings: {e}"),
                }
                if let Err(e) = history::prune(&state, Vec::new()) {
                    eprintln!("history: auto-delete failed: {e}");
                }
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth::auth_status,
            auth::auth_set_key,
            auth::auth_clear,
            config::get_app_config,
            models::list_models,
            chat::chat_send,
            chat::chat_cancel,
            history::conversations_list,
            history::conversation_get,
            history::conversation_update,
            history::conversation_rename,
            history::conversation_delete,
            history::conversation_generate_title,
            history::save_markdown,
            history::history_info,
            history::history_prune,
            history::history_delete_all,
            history::history_reveal,
            settings::settings_get,
            settings::settings_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
