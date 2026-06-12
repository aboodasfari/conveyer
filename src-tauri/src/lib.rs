mod ado;
mod commands;
mod db;
mod error;
mod models;
mod state;

use state::AppState;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match db::init().await {
                    Ok(pool) => {
                        handle.manage(AppState::new(pool));
                        tracing::info!("database ready");
                    }
                    Err(e) => tracing::error!("db init failed: {e}"),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::settings::settings_all,
            commands::sources::sources_list,
            commands::sources::sources_upsert,
            commands::sources::sources_update,
            commands::sources::sources_delete,
            commands::sources::sources_test,
            commands::tasks::tasks_list,
            commands::tasks::tasks_refresh,
            commands::tasks::tasks_add_by_url,
            commands::gates::gates_list,
            commands::gates::gates_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
