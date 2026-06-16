//! Review comments left on the diff while a phase is gated (waiting).
//!
//! Lifecycle: a comment starts `queued`. A per-phase processor
//! (see `session_runner::comment_processor`) sends queued comments to the
//! agent one at a time over the warm chat sidecar — `working` while the
//! agent addresses it, `addressed` once it replies. The user then
//! `accept`s it (terminal) or `reopen`s with a follow-up (back to queued).

use crate::error::{AppError, AppResult};
use crate::session_runner;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Comment {
    pub id: String,
    pub phase_id: String,
    pub file_path: String,
    pub line_start: Option<i64>,
    pub line_end: Option<i64>,
    pub side: Option<String>,
    pub snippet: Option<String>,
    pub body: String,
    pub status: String,
    pub agent_reply: Option<String>,
    pub commit_marker: String,
    pub thread_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const COMMENT_COLS: &str =
    "id, phase_id, file_path, line_start, line_end, side, snippet, body, \
     status, agent_reply, commit_marker, thread_json, created_at, updated_at";

#[tauri::command]
pub async fn comments_for_phase(
    state: State<'_, AppState>,
    phase_id: String,
) -> AppResult<Vec<Comment>> {
    let rows = sqlx::query_as::<_, Comment>(&format!(
        "SELECT {COMMENT_COLS} FROM comments WHERE phase_id = ? ORDER BY created_at, id"
    ))
    .bind(&phase_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
pub struct NewComment {
    pub phase_id: String,
    pub file_path: String,
    pub line_start: Option<i64>,
    pub line_end: Option<i64>,
    pub side: Option<String>,
    pub snippet: Option<String>,
    pub body: String,
}

#[tauri::command]
pub async fn comment_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: NewComment,
) -> AppResult<Comment> {
    let body = input.body.trim().to_string();
    if body.is_empty() {
        return Err(AppError::Config("Comment is empty.".into()));
    }
    let id = Uuid::new_v4().to_string();
    // Short, stable marker the agent embeds in its commit message so
    // follow-ups in this thread can find + amend the same commit.
    let marker = id.split('-').next().unwrap_or(&id).to_string();
    let thread = serde_json::json!([{ "role": "user", "content": body }]).to_string();
    sqlx::query(
        "INSERT INTO comments(id, phase_id, file_path, line_start, line_end, side, snippet, body, status, commit_marker, thread_json)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
    )
    .bind(&id)
    .bind(&input.phase_id)
    .bind(&input.file_path)
    .bind(input.line_start)
    .bind(input.line_end)
    .bind(&input.side)
    .bind(&input.snippet)
    .bind(&body)
    .bind(&marker)
    .bind(&thread)
    .execute(&state.db)
    .await?;

    let comment = load_comment(&state, &id).await?;
    let _ = app.emit("comments_changed", serde_json::json!({ "phase_id": input.phase_id }));
    // Kick the processor; it's idempotent and drains the queue.
    session_runner::kick_comment_processor(app.clone(), input.phase_id.clone());
    Ok(comment)
}

#[tauri::command]
pub async fn comment_accept(
    app: AppHandle,
    state: State<'_, AppState>,
    comment_id: String,
) -> AppResult<Comment> {
    sqlx::query(
        "UPDATE comments SET status='accepted', updated_at=datetime('now')
         WHERE id=? AND status='addressed'",
    )
    .bind(&comment_id)
    .execute(&state.db)
    .await?;
    let c = load_comment(&state, &comment_id).await?;
    let _ = app.emit("comments_changed", serde_json::json!({ "phase_id": c.phase_id }));
    Ok(c)
}

#[derive(Debug, Deserialize)]
pub struct ReopenComment {
    pub comment_id: String,
    pub follow_up: String,
}

#[tauri::command]
pub async fn comment_reopen(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ReopenComment,
) -> AppResult<Comment> {
    let follow_up = input.follow_up.trim().to_string();
    if follow_up.is_empty() {
        return Err(AppError::Config("Follow-up is empty.".into()));
    }
    // Append the follow-up as a new user message in the thread and
    // re-queue. Body is left as the original first-line preview.
    let existing = load_comment(&state, &input.comment_id).await?;
    let mut thread: Vec<serde_json::Value> = existing
        .thread_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    thread.push(serde_json::json!({ "role": "user", "content": follow_up }));
    let thread_str = serde_json::to_string(&thread).unwrap_or_default();
    sqlx::query(
        "UPDATE comments SET thread_json=?, status='queued', updated_at=datetime('now')
         WHERE id=?",
    )
    .bind(&thread_str)
    .bind(&input.comment_id)
    .execute(&state.db)
    .await?;
    let comment = load_comment(&state, &input.comment_id).await?;
    let _ = app.emit("comments_changed", serde_json::json!({ "phase_id": existing.phase_id }));
    session_runner::kick_comment_processor(app.clone(), existing.phase_id.clone());
    Ok(comment)
}

#[tauri::command]
pub async fn comment_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    comment_id: String,
) -> AppResult<()> {
    // Capture phase before delete so we can notify the right viewer.
    let phase: Option<(String,)> =
        sqlx::query_as("SELECT phase_id FROM comments WHERE id = ?")
            .bind(&comment_id)
            .fetch_optional(&state.db)
            .await?;
    // Only allow deleting comments that aren't mid-flight.
    sqlx::query("DELETE FROM comments WHERE id=? AND status != 'working'")
        .bind(&comment_id)
        .execute(&state.db)
        .await?;
    if let Some((phase_id,)) = phase {
        let _ = app.emit("comments_changed", serde_json::json!({ "phase_id": phase_id }));
    }
    Ok(())
}

pub async fn load_comment(state: &AppState, id: &str) -> AppResult<Comment> {
    let row = sqlx::query_as::<_, Comment>(&format!(
        "SELECT {COMMENT_COLS} FROM comments WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    row.ok_or_else(|| AppError::Config("Comment not found.".into()))
}
