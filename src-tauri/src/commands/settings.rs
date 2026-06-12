use crate::error::AppResult;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?")
        .bind(&key)
        .fetch_optional(&state.db)
        .await?;
    Ok(row.map(|r| r.0))
}

#[tauri::command]
pub async fn settings_set(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO settings(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(&key)
    .bind(&value)
    .execute(&state.db)
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn settings_all(state: State<'_, AppState>) -> AppResult<Vec<(String, String)>> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM settings")
        .fetch_all(&state.db)
        .await?;
    Ok(rows)
}
