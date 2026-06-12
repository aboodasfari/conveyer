use crate::error::AppResult;
use crate::models::Source;
use crate::state::AppState;
use serde::Deserialize;
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct SourceInput {
    pub kind: String,
    pub name: String,
    pub config_json: String,
    pub pat_env: String,
    pub enabled: bool,
}

#[tauri::command]
pub async fn sources_list(state: State<'_, AppState>) -> AppResult<Vec<Source>> {
    let rows = sqlx::query_as::<_, Source>(
        "SELECT id, kind, name, config_json, pat_env, enabled, created_at
         FROM sources ORDER BY created_at",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[tauri::command]
pub async fn sources_upsert(state: State<'_, AppState>, input: SourceInput) -> AppResult<Source> {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sources(id, kind, name, config_json, pat_env, enabled)
         VALUES(?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&input.kind)
    .bind(&input.name)
    .bind(&input.config_json)
    .bind(&input.pat_env)
    .bind(input.enabled as i64)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, Source>(
        "SELECT id, kind, name, config_json, pat_env, enabled, created_at
         FROM sources WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

#[tauri::command]
pub async fn sources_update(
    state: State<'_, AppState>,
    id: String,
    input: SourceInput,
) -> AppResult<Source> {
    sqlx::query(
        "UPDATE sources SET kind=?, name=?, config_json=?, pat_env=?, enabled=? WHERE id=?",
    )
    .bind(&input.kind)
    .bind(&input.name)
    .bind(&input.config_json)
    .bind(&input.pat_env)
    .bind(input.enabled as i64)
    .bind(&id)
    .execute(&state.db)
    .await?;
    let row = sqlx::query_as::<_, Source>(
        "SELECT id, kind, name, config_json, pat_env, enabled, created_at FROM sources WHERE id=?",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

#[tauri::command]
pub async fn sources_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sqlx::query("DELETE FROM sources WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}
