//! Workspaces: named code repos Conveyer can run agents in.
//!
//! Tasks default to an empty workspace selection, in which case the prompt
//! lists all workspaces so the agent can pick the right one. Setting an
//! explicit `tasks.workspace_path` pins the task to a specific path.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Workspace {
    pub id: i64,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceInput {
    pub name: String,
    pub path: String,
}

#[tauri::command]
pub async fn workspaces_list(state: State<'_, AppState>) -> AppResult<Vec<Workspace>> {
    let rows = sqlx::query_as::<_, Workspace>(
        "SELECT id, name, path FROM workspaces ORDER BY name COLLATE NOCASE",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

/// Insert if `id` is None, otherwise update the row with that id.
/// Path must be unique across all workspaces.
#[tauri::command]
pub async fn workspace_upsert(
    state: State<'_, AppState>,
    id: Option<i64>,
    input: WorkspaceInput,
) -> AppResult<Workspace> {
    let name = input.name.trim().to_string();
    let path = input.path.trim().to_string();
    if name.is_empty() || path.is_empty() {
        return Err(AppError::Config("Workspace name and path are required.".into()));
    }
    let id = if let Some(id) = id {
        sqlx::query("UPDATE workspaces SET name = ?, path = ? WHERE id = ?")
            .bind(&name)
            .bind(&path)
            .bind(id)
            .execute(&state.db)
            .await?;
        id
    } else {
        let res = sqlx::query("INSERT INTO workspaces(name, path) VALUES(?, ?)")
            .bind(&name)
            .bind(&path)
            .execute(&state.db)
            .await?;
        res.last_insert_rowid()
    };
    let row = sqlx::query_as::<_, Workspace>(
        "SELECT id, name, path FROM workspaces WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

#[tauri::command]
pub async fn workspace_delete(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM workspaces WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Set or clear the workspace for a task. Pass `None` to clear so the prompt
/// falls back to listing all workspaces. Freeform paths are accepted — they
/// don't have to be in the workspaces table.
#[tauri::command]
pub async fn task_set_workspace(
    state: State<'_, AppState>,
    task_id: String,
    workspace_path: Option<String>,
) -> AppResult<()> {
    let p = workspace_path.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    sqlx::query("UPDATE tasks SET workspace_path = ? WHERE id = ?")
        .bind(&p)
        .bind(&task_id)
        .execute(&state.db)
        .await?;
    Ok(())
}
