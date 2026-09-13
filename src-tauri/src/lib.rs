mod auth;
mod chat;
mod config;
mod context;
mod credentials;
mod error;
mod gateway;
mod models;
mod sse;
mod state;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let gateway = gateway::Gateway::new()?;
            let data_dir = app.path().app_data_dir()?;
            app.manage(state::AppState::new(gateway, data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth::auth_status,
            auth::auth_set_key,
            auth::auth_clear,
            config::get_app_config,
            models::list_models,
            chat::chat_stream,
            chat::chat_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
