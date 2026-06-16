use crate::error::AppResult;
use crate::session_runner;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Stdio;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

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
    pub sdk_session_id: Option<String>,
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
        "SELECT id, phase_id, role, status, pid, log_path, started_at, finished_at, sdk_session_id
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

/// Returns the rendered prompt the sidecar fed to the agent for this phase,
/// if it has been captured. Stored as `prompt.md` in the phase's artifact
/// directory by the sidecar's render_prompt pre-step. We derive the path
/// from the phase's task_id + kind directly so it works *during* the run
/// (phases.artifact_path is only set once the agent writes its artifact).
#[tauri::command]
pub async fn phase_prompt_get(state: State<'_, AppState>, phase_id: String) -> AppResult<Option<String>> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT r.task_id, p.kind
         FROM phases p JOIN runs r ON r.id = p.run_id
         WHERE p.id = ?",
    )
    .bind(&phase_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((task_id, kind)) = row else { return Ok(None) };
    let artifact_path = crate::session_runner::artifact_path_for(&task_id, 1, &kind)?;
    let prompt_path = artifact_path
        .parent()
        .map(|p| p.join("prompt.md"));
    let Some(prompt_path) = prompt_path else { return Ok(None) };
    match tokio::fs::read_to_string(&prompt_path).await {
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

/// Send a chat message to the agent for an existing phase. Resumes the
/// SDK session of the most recent session row that has a sdk_session_id
/// and feeds the agent the user's message. The reply streams into a new
/// `sessions` row attached to the same phase; the phase's pipeline
/// status (waiting / failed / done) is left alone.
#[tauri::command]
pub async fn chat_reply(
    app: AppHandle,
    phase_id: String,
    content: String,
) -> AppResult<()> {
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() {
        return Err(crate::error::AppError::Config(
            "Reply is empty.".to_string(),
        ));
    }

    let registry = app.state::<session_runner::RunnerRegistry>();
    if registry.active_session(&phase_id).is_some() {
        return Err(crate::error::AppError::Config(
            "Agent is busy. Stop the current run before replying.".to_string(),
        ));
    }

    // Hand off to the warm chat sidecar (which spawns lazily on first
    // use and stays warm for ~5 min so subsequent replies are instant).
    session_runner::chat_send_reply(app.clone(), phase_id, trimmed).await
}

/// Heartbeat ping from the UI while a chat tab is mounted. Resets the
/// warm chat sidecar's idle timer so it stays alive while the user is
/// looking at the chat (even if they don't type for a while). No-op
/// when there's no warm sidecar — first reply will spawn one.
#[tauri::command]
pub async fn chat_heartbeat(app: AppHandle, phase_id: String) -> AppResult<()> {
    session_runner::chat_heartbeat(&app, &phase_id).await;
    Ok(())
}

/// Eagerly spawn the warm chat sidecar for `phase_id` so the user
/// doesn't pay the SDK cold-start cost on their first message.
/// Called by the UI when the chat tab mounts. Best-effort: silently
/// no-ops if there's no resumable SDK session yet.
#[tauri::command]
pub async fn chat_warm(app: AppHandle, phase_id: String) -> AppResult<()> {
    session_runner::chat_warm(&app, &phase_id).await;
    Ok(())
}

/// Answer a pending `ask_user` / needs_input request raised by the agent
/// mid-phase. Delivers the answer to the live sidecar, records it in the
/// transcript, and resumes the phase.
#[tauri::command]
pub async fn phase_submit_input(
    app: AppHandle,
    phase_id: String,
    content: String,
) -> AppResult<()> {
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() {
        return Err(crate::error::AppError::Config("Answer is empty.".into()));
    }
    session_runner::submit_input(&app, &phase_id, &trimmed).await
}

#[derive(Debug, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_reasoning_efforts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<String>,
}

/// Ask the Copilot SDK for the available models by spawning the sidecar in
/// list_models mode. Returns an empty list (plus the error in the log) if
/// the SDK can't be reached.
#[tauri::command]
pub async fn models_list() -> AppResult<Vec<ModelInfo>> {
    let Some(sidecar) = session_runner::sidecar_path() else {
        return Ok(vec![]);
    };
    let mut cmd = Command::new("node");
    cmd.arg(&sidecar)
        .env("CONVEYER_MODE", "list_models")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("failed to spawn sidecar for list_models: {e}");
            return Ok(vec![]);
        }
    };
    let stdout = child.stdout.take().expect("piped");
    let mut reader = BufReader::new(stdout).lines();
    let mut models = vec![];
    while let Ok(Some(line)) = reader.next_line().await {
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            if v.get("type").and_then(|t| t.as_str()) == Some("models") {
                if let Some(arr) = v.get("models").and_then(|m| m.as_array()) {
                    for m in arr {
                        let id = m.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        let name = m.get("name").and_then(|x| x.as_str()).unwrap_or(&id).to_string();
                        if id.is_empty() {
                            continue;
                        }
                        let supported = m
                            .get("supported_reasoning_efforts")
                            .and_then(|x| x.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect::<Vec<_>>()
                            });
                        let default = m
                            .get("default_reasoning_effort")
                            .and_then(|x| x.as_str())
                            .map(String::from);
                        models.push(ModelInfo {
                            id,
                            name,
                            supported_reasoning_efforts: supported,
                            default_reasoning_effort: default,
                        });
                    }
                }
            }
        }
    }
    let _ = child.wait().await;
    Ok(models)
}
