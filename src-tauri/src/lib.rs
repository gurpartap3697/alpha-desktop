mod auth;
mod chat;
mod error;
mod gateway;
mod sse;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let gateway = gateway::Gateway::new().expect("failed to build HTTP client");

    tauri::Builder::default()
        .manage(state::AppState::new(gateway))
        .invoke_handler(tauri::generate_handler![
            auth::auth_set_key,
            auth::auth_status,
            auth::auth_clear,
            auth::list_models,
            chat::chat_stream,
            chat::chat_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
