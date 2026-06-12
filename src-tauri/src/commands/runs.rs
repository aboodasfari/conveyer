//! Run + phase lifecycle.
//!
//! A "run" is one full attempt at tackling a task. It owns 5 ordered phases
//! (exploration → planning → implementation → review → submit). Until the
//! Copilot session runner ships in M4, phases transition via user action
//! only — there's a stub Complete button per running phase and an Approve
//! button on phases that are waiting on a gate.
//!
//! State machine:
//!   pending → running (via runs_start, or when previous phase auto-advances)
//!   running → done    (via phase_complete; M4: when the session exits)
//!   done    → next phase enters either running OR waiting, based on the gate
//!   waiting → running (via phase_approve)

use crate::error::{AppError, AppResult};
use crate::models::{Phase, Run, PHASE_KINDS};
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct RunDetail {
    pub run: Run,
    pub phases: Vec<Phase>,
}

const RUN_COLS: &str = "id, task_id, status, started_at, finished_at";
const PHASE_COLS: &str =
    "id, run_id, kind, ord, status, started_at, finished_at, artifact_path";

#[tauri::command]
pub async fn runs_start(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> AppResult<RunDetail> {
    // Reject if there's already an active run for the task.
    let active: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM runs WHERE task_id = ?
         AND status IN ('pending','running','waiting') LIMIT 1",
    )
    .bind(&task_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some((id,)) = active {
        return Err(AppError::Config(format!(
            "This task already has an active run ({id})."
        )));
    }

    let run_id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO runs(id, task_id, status) VALUES(?, ?, 'running')")
        .bind(&run_id)
        .bind(&task_id)
        .execute(&state.db)
        .await?;

    for (ord, kind) in PHASE_KINDS.iter().enumerate() {
        let phase_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO phases(id, run_id, kind, ord, status) VALUES(?, ?, ?, ?, 'pending')",
        )
        .bind(&phase_id)
        .bind(&run_id)
        .bind(*kind)
        .bind(ord as i64)
        .execute(&state.db)
        .await?;
    }

    // Start the first phase immediately. Gates only apply between phases.
    sqlx::query(
        "UPDATE phases SET status='running', started_at=datetime('now')
         WHERE run_id=? AND ord=0",
    )
    .bind(&run_id)
    .execute(&state.db)
    .await?;

    let detail = run_get_inner(&state, &run_id).await?;
    emit_run_updated(&app, &task_id, &run_id);
    Ok(detail)
}

#[tauri::command]
pub async fn runs_for_task(state: State<'_, AppState>, task_id: String) -> AppResult<Vec<Run>> {
    let rows = sqlx::query_as::<_, Run>(&format!(
        "SELECT {RUN_COLS} FROM runs WHERE task_id = ? ORDER BY started_at DESC"
    ))
    .bind(&task_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[tauri::command]
pub async fn run_get(state: State<'_, AppState>, run_id: String) -> AppResult<RunDetail> {
    run_get_inner(&state, &run_id).await
}

async fn run_get_inner(state: &AppState, run_id: &str) -> AppResult<RunDetail> {
    let run = sqlx::query_as::<_, Run>(&format!("SELECT {RUN_COLS} FROM runs WHERE id = ?"))
        .bind(run_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("run {run_id}")))?;
    let phases = sqlx::query_as::<_, Phase>(&format!(
        "SELECT {PHASE_COLS} FROM phases WHERE run_id = ? ORDER BY ord"
    ))
    .bind(run_id)
    .fetch_all(&state.db)
    .await?;
    Ok(RunDetail { run, phases })
}

#[tauri::command]
pub async fn phase_complete(
    app: AppHandle,
    state: State<'_, AppState>,
    phase_id: String,
) -> AppResult<RunDetail> {
    let phase = load_phase(&state, &phase_id).await?;

    if phase.status != "running" {
        return Err(AppError::Config(format!(
            "Phase '{}' is in state '{}' — only running phases can be completed.",
            phase.kind, phase.status
        )));
    }

    sqlx::query("UPDATE phases SET status='done', finished_at=datetime('now') WHERE id = ?")
        .bind(&phase_id)
        .execute(&state.db)
        .await?;

    advance_after(&state, &phase.run_id, phase.ord).await?;
    let detail = run_get_inner(&state, &phase.run_id).await?;
    emit_run_updated_for_run(&app, &state, &phase.run_id).await;
    Ok(detail)
}

#[tauri::command]
pub async fn phase_approve(
    app: AppHandle,
    state: State<'_, AppState>,
    phase_id: String,
) -> AppResult<RunDetail> {
    let phase = load_phase(&state, &phase_id).await?;

    if phase.status != "waiting" {
        return Err(AppError::Config(format!(
            "Phase '{}' is in state '{}' — only waiting phases can be approved.",
            phase.kind, phase.status
        )));
    }

    sqlx::query(
        "UPDATE phases SET status='running', started_at=datetime('now') WHERE id=?",
    )
    .bind(&phase_id)
    .execute(&state.db)
    .await?;
    // Bring the run back to 'running' too.
    sqlx::query("UPDATE runs SET status='running' WHERE id=?")
        .bind(&phase.run_id)
        .execute(&state.db)
        .await?;

    let detail = run_get_inner(&state, &phase.run_id).await?;
    emit_run_updated_for_run(&app, &state, &phase.run_id).await;
    Ok(detail)
}

async fn load_phase(state: &AppState, phase_id: &str) -> AppResult<Phase> {
    sqlx::query_as::<_, Phase>(&format!(
        "SELECT {PHASE_COLS} FROM phases WHERE id = ?"
    ))
    .bind(phase_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("phase {phase_id}")))
}

/// After finishing the phase at `prev_ord`, either start the next phase
/// (if its gate auto-advances) or set it to 'waiting'. If there's no next
/// phase, mark the run done.
async fn advance_after(state: &AppState, run_id: &str, prev_ord: i64) -> AppResult<()> {
    let next: Option<Phase> = sqlx::query_as::<_, Phase>(&format!(
        "SELECT {PHASE_COLS} FROM phases WHERE run_id=? AND ord=?"
    ))
    .bind(run_id)
    .bind(prev_ord + 1)
    .fetch_optional(&state.db)
    .await?;

    let Some(next) = next else {
        sqlx::query(
            "UPDATE runs SET status='done', finished_at=datetime('now') WHERE id=?",
        )
        .bind(run_id)
        .execute(&state.db)
        .await?;
        return Ok(());
    };

    let auto: Option<(i64,)> =
        sqlx::query_as("SELECT auto_advance FROM gates WHERE phase_kind = ?")
            .bind(&next.kind)
            .fetch_optional(&state.db)
            .await?;
    let auto = auto.map(|(v,)| v == 1).unwrap_or(false);

    if auto {
        sqlx::query(
            "UPDATE phases SET status='running', started_at=datetime('now') WHERE id=?",
        )
        .bind(&next.id)
        .execute(&state.db)
        .await?;
    } else {
        sqlx::query("UPDATE phases SET status='waiting' WHERE id=?")
            .bind(&next.id)
            .execute(&state.db)
            .await?;
        sqlx::query("UPDATE runs SET status='waiting' WHERE id=?")
            .bind(run_id)
            .execute(&state.db)
            .await?;
    }
    Ok(())
}

fn emit_run_updated(app: &AppHandle, task_id: &str, run_id: &str) {
    let _ = app.emit(
        "run_updated",
        serde_json::json!({ "task_id": task_id, "run_id": run_id }),
    );
}

async fn emit_run_updated_for_run(app: &AppHandle, state: &AppState, run_id: &str) {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT task_id FROM runs WHERE id = ?")
            .bind(run_id)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);
    if let Some((task_id,)) = row {
        emit_run_updated(app, &task_id, run_id);
    }
}
