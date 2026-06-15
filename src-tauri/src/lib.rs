mod ado;
mod commands;
mod db;
mod error;
mod macos;
mod models;
mod session_runner;
mod state;
mod worktree;

use session_runner::RunnerRegistry;
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(RunnerRegistry::new())
        .setup(|app| {
            // In `tauri dev` we run the bare binary, not a proper .app
            // bundle — so macOS falls back to the binary's name ("conveyer")
            // and the default Tauri icon. Patch both at runtime.
            macos::set_process_name("Conveyer");
            macos::set_dock_icon(include_bytes!("../icons/icon.png"));

            // Attach an empty NSToolbar so the title bar is tall enough for
            // the macOS traffic lights to sit centred against our header.
            if let Some(win) = app.get_webview_window("main") {
                macos::extend_titlebar(&win);
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match db::init().await {
                    Ok(pool) => {
                        let state = AppState::new(pool);
                        if let Err(e) = session_runner::reconcile_orphaned_runs(&state).await {
                            tracing::error!("reconcile orphaned runs: {e}");
                        }
                        handle.manage(state);
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
            commands::tasks::tasks_set_bucket,
            commands::tasks::tasks_seed_demo,
            commands::tasks::tasks_create_local,
            commands::tasks::tasks_delete,
            commands::gates::gates_list,
            commands::gates::gates_set,
            commands::runs::runs_start,
            commands::runs::runs_for_task,
            commands::runs::run_get,
            commands::runs::phase_complete,
            commands::runs::phase_approve,
            commands::runs::phase_rewind,
            commands::runs::phase_restart,
            commands::sessions::sessions_for_phase,
            commands::sessions::messages_for_session,
            commands::sessions::phase_artifact_get,
            commands::sessions::phase_prompt_get,
            commands::sessions::session_cancel,
            commands::sessions::models_list,
            commands::diff::phase_diff_summary,
            commands::diff::phase_diff_text,
            commands::workspaces::workspaces_list,
            commands::workspaces::workspace_upsert,
            commands::workspaces::workspace_delete,
            commands::workspaces::task_set_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
