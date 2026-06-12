use crate::error::AppResult;
use crate::session_runner;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Session {
    pub id: String,
    pub phase_id: String,
    pub role: String,
    pub status: String,
    pub pid: Option<i64>,
    pub log_path: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Message {
    pub id: i64,
    pub session_id: String,
    pub ts: String,
    pub role: String,
    pub content: String,
}

/// Sessions attached to a phase. Usually exactly one ("main") today, but
/// implementation will fan out into multiple in M5.
#[tauri::command]
pub async fn sessions_for_phase(state: State<'_, AppState>, phase_id: String) -> AppResult<Vec<Session>> {
    let rows = sqlx::query_as::<_, Session>(
        "SELECT id, phase_id, role, status, pid, log_path, started_at, finished_at
         FROM sessions WHERE phase_id = ? ORDER BY started_at",
    )
    .bind(&phase_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[tauri::command]
pub async fn messages_for_session(state: State<'_, AppState>, session_id: String) -> AppResult<Vec<Message>> {
    let rows = sqlx::query_as::<_, Message>(
        "SELECT id, session_id, ts, role, content
         FROM messages WHERE session_id = ? ORDER BY id",
    )
    .bind(&session_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

/// Returns the captured artifact content for a phase, if any.
#[tauri::command]
pub async fn phase_artifact_get(state: State<'_, AppState>, phase_id: String) -> AppResult<Option<String>> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT artifact_path FROM phases WHERE id = ?",
    )
    .bind(&phase_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((Some(path),)) = row else { return Ok(None) };
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => Ok(Some(s)),
        Err(_) => Ok(None),
    }
}

/// Cancel any live sidecar attached to this phase. Returns true if there
/// was one to cancel.
#[tauri::command]
pub async fn session_cancel(app: AppHandle, phase_id: String) -> AppResult<bool> {
    let registry = app.state::<session_runner::RunnerRegistry>();
    Ok(registry.cancel(&phase_id).is_some())
}
