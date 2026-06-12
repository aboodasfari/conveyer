use crate::error::AppResult;
use crate::models::{Gate, PHASE_KINDS};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn gates_list(state: State<'_, AppState>) -> AppResult<Vec<Gate>> {
    let mut rows = sqlx::query_as::<_, Gate>(
        "SELECT phase_kind, auto_advance FROM gates",
    )
    .fetch_all(&state.db)
    .await?;
    // Ensure stable order matching PHASE_KINDS.
    rows.sort_by_key(|g| {
        PHASE_KINDS
            .iter()
            .position(|k| *k == g.phase_kind)
            .unwrap_or(usize::MAX)
    });
    Ok(rows)
}

#[tauri::command]
pub async fn gates_set(
    state: State<'_, AppState>,
    phase_kind: String,
    auto_advance: bool,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO gates(phase_kind, auto_advance) VALUES(?, ?)
         ON CONFLICT(phase_kind) DO UPDATE SET auto_advance = excluded.auto_advance",
    )
    .bind(&phase_kind)
    .bind(auto_advance as i64)
    .execute(&state.db)
    .await?;
    Ok(())
}
