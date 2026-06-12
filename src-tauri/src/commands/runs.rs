//! Run + phase lifecycle.
//!
//! A "run" is one full attempt at tackling a task. It owns 5 ordered phases
//! (exploration → planning → implementation → review → submit). Until the
//! Copilot session runner ships in M4, phases transition via user action
//! only — there's a stub Complete button per running phase and an Approve
//! button on phases that have finished but are awaiting human sign-off.
//!
//! Gate semantics: the gate for a phase decides what happens **after** that
//! phase finishes — auto-advance the run, or pause for user approval first.
//!
//! State machine:
//!   pending  → running       (runs_start, or after auto-advance from prev)
//!   running  → done          (phase_complete, if this phase's gate auto-advances)
//!   running  → waiting       (phase_complete, if this phase's gate is manual)
//!   waiting  → done          (phase_approve)
//!   done     → (next phase running, OR run done if there is no next)

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

    let auto = gate_auto_advance(&state, &phase.kind).await?;

    if auto {
        sqlx::query(
            "UPDATE phases SET status='done', finished_at=datetime('now') WHERE id=?",
        )
        .bind(&phase_id)
        .execute(&state.db)
        .await?;
        start_next_phase(&state, &phase.run_id, phase.ord).await?;
    } else {
        // Awaiting user approval before we advance.
        sqlx::query(
            "UPDATE phases SET status='waiting', finished_at=datetime('now') WHERE id=?",
        )
        .bind(&phase_id)
        .execute(&state.db)
        .await?;
        sqlx::query("UPDATE runs SET status='waiting' WHERE id=?")
            .bind(&phase.run_id)
            .execute(&state.db)
            .await?;
    }

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

    // Mark the just-completed phase as done, then advance to the next.
    sqlx::query("UPDATE phases SET status='done' WHERE id=?")
        .bind(&phase_id)
        .execute(&state.db)
        .await?;
    start_next_phase(&state, &phase.run_id, phase.ord).await?;

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

/// Send the pipeline back to an earlier phase. Sets the target phase to
/// running, all subsequent phases back to pending (clearing their times),
/// and brings the run back to running. Useful for e.g. "Review found
/// something — back to Implementation".
#[tauri::command]
pub async fn phase_rewind(
    app: AppHandle,
    state: State<'_, AppState>,
    phase_id: String,
) -> AppResult<RunDetail> {
    let target = load_phase(&state, &phase_id).await?;

    let mut tx = state.db.begin().await?;
    // Reset target to running.
    sqlx::query(
        "UPDATE phases SET status='running', started_at=datetime('now'),
                            finished_at=NULL WHERE id=?",
    )
    .bind(&target.id)
    .execute(&mut *tx)
    .await?;
    // Clear all phases after the target.
    sqlx::query(
        "UPDATE phases SET status='pending', started_at=NULL, finished_at=NULL
         WHERE run_id=? AND ord > ?",
    )
    .bind(&target.run_id)
    .bind(target.ord)
    .execute(&mut *tx)
    .await?;
    // Run is active again.
    sqlx::query(
        "UPDATE runs SET status='running', finished_at=NULL WHERE id=?",
    )
    .bind(&target.run_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let detail = run_get_inner(&state, &target.run_id).await?;
    emit_run_updated_for_run(&app, &state, &target.run_id).await;
    Ok(detail)
}

async fn gate_auto_advance(state: &AppState, kind: &str) -> AppResult<bool> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT auto_advance FROM gates WHERE phase_kind = ?")
            .bind(kind)
            .fetch_optional(&state.db)
            .await?;
    Ok(row.map(|(v,)| v == 1).unwrap_or(false))
}

/// Start the phase after `prev_ord`. If there is no next phase, the run is
/// complete and gets marked `done`. Otherwise the run goes back to `running`.
async fn start_next_phase(state: &AppState, run_id: &str, prev_ord: i64) -> AppResult<()> {
    let next: Option<Phase> = sqlx::query_as::<_, Phase>(&format!(
        "SELECT {PHASE_COLS} FROM phases WHERE run_id=? AND ord=?"
    ))
    .bind(run_id)
    .bind(prev_ord + 1)
    .fetch_optional(&state.db)
    .await?;

    if let Some(next) = next {
        sqlx::query(
            "UPDATE phases SET status='running', started_at=datetime('now') WHERE id=?",
        )
        .bind(&next.id)
        .execute(&state.db)
        .await?;
        sqlx::query("UPDATE runs SET status='running' WHERE id=?")
            .bind(run_id)
            .execute(&state.db)
            .await?;
    } else {
        sqlx::query(
            "UPDATE runs SET status='done', finished_at=datetime('now') WHERE id=?",
        )
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
