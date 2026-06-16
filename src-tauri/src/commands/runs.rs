//! Run + phase lifecycle.
//!
//! A "run" is one full attempt at tackling a task. It owns 5 ordered phases
//! (exploration → planning → implementation → review → submit). Phases are
//! driven by Copilot subprocesses (the "session runner") which write their
//! output to the messages table and update phase.artifact_path. The runner
//! calls back into this module via `complete_phase_internal` when the
//! subprocess exits cleanly.
//!
//! Gate semantics: the gate for a phase decides what happens **after** that
//! phase finishes — auto-advance the run, or pause for user approval first.

use crate::error::{AppError, AppResult};
use crate::models::{Phase, Run, PHASE_KINDS};
use crate::session_runner;
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct RunDetail {
    pub run: Run,
    pub phases: Vec<Phase>,
}

const RUN_COLS: &str = "id, task_id, status, started_at, finished_at";
const PHASE_COLS: &str =
    "id, run_id, kind, ord, status, started_at, finished_at, artifact_path, \
     review_verdict, review_reason, pending_input";

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

    // Honor the "disable submit phase" setting — when false, skip the
    // submit phase entirely so the run finishes after review.
    let submit_enabled: bool = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = 'phase_submit_enabled'",
    )
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .map(|v| v != "0" && v.to_ascii_lowercase() != "false")
    .unwrap_or(true);

    let phases: Vec<&str> = PHASE_KINDS
        .iter()
        .copied()
        .filter(|k| submit_enabled || *k != "submit")
        .collect();

    for (ord, kind) in phases.iter().enumerate() {
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

    // Spawn the runner for phase 0.
    if let Some(p0) = detail.phases.first() {
        session_runner::spawn_for_phase(app.clone(), p0.id.clone());
    }

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
    // If there's an active sidecar for this phase, cancel it — the user
    // is choosing to advance manually. The runner won't auto-advance
    // because its `ok` flag stays false on cancel.
    let registry = app.state::<session_runner::RunnerRegistry>();
    let _ = registry.cancel(&phase_id);

    complete_phase_internal(&app, &state, &phase_id).await
}

/// Mark `phase_id` complete and advance the pipeline. Called both from
/// the IPC handler above and from `session_runner` when a sidecar exits
/// cleanly.
pub async fn complete_phase_internal(
    app: &AppHandle,
    state: &AppState,
    phase_id: &str,
) -> AppResult<RunDetail> {
    let phase = load_phase(state, phase_id).await?;

    if phase.status != "running" {
        // Treat as no-op rather than an error — the runner might race.
        return run_get_inner(state, &phase.run_id).await;
    }

    // Submit phase is special: the main turn only *drafts* a PR (status
    // 'draft'). We don't finish the phase here. Instead we either auto-create
    // it (gate on) or show the preview and wait for the user to approve
    // creation (gate off). The phase becomes 'done' later, when the agent
    // reports the PR created (finalize_submit_internal). If the agent never
    // proposed a PR, fall through to the normal completion path below.
    if phase.kind == "submit" {
        let has_draft: Option<(String,)> = sqlx::query_as(
            "SELECT status FROM pull_requests WHERE phase_id = ?",
        )
        .bind(phase_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some((pr_status,)) = has_draft {
            // Only intervene while the PR hasn't been created yet.
            if pr_status == "draft" || pr_status == "failed" {
                let auto = gate_auto_advance(state, &phase.kind).await?;
                if auto {
                    // Keep the phase 'running' while the agent creates it.
                    session_runner::pr_begin_create(app, state, phase_id).await?;
                } else {
                    // Show the PR preview; wait for the user to click Create.
                    sqlx::query(
                        "UPDATE phases SET status='waiting', finished_at=datetime('now') WHERE id=?",
                    )
                    .bind(phase_id)
                    .execute(&state.db)
                    .await?;
                    sqlx::query("UPDATE runs SET status='waiting' WHERE id=?")
                        .bind(&phase.run_id)
                        .execute(&state.db)
                        .await?;
                }
                let detail = run_get_inner(state, &phase.run_id).await?;
                emit_run_updated_for_run(app, state, &phase.run_id).await;
                return Ok(detail);
            }
        }
    }

    let auto = gate_auto_advance(state, &phase.kind).await?;

    if auto {
        sqlx::query(
            "UPDATE phases SET status='done', finished_at=datetime('now') WHERE id=?",
        )
        .bind(phase_id)
        .execute(&state.db)
        .await?;
        if phase.kind == "review" {
            sqlx::query(
                "UPDATE phases SET review_verdict='approve', review_reason=NULL
                 WHERE id=? AND review_verdict IS NULL",
            )
            .bind(phase_id)
            .execute(&state.db)
            .await?;
        }
        let next_id = start_next_phase(state, &phase.run_id, phase.ord).await?;
        if let Some(id) = next_id {
            session_runner::spawn_for_phase(app.clone(), id);
        }
    } else {
        // Awaiting user approval before we advance.
        sqlx::query(
            "UPDATE phases SET status='waiting', finished_at=datetime('now') WHERE id=?",
        )
        .bind(phase_id)
        .execute(&state.db)
        .await?;
        if phase.kind == "review" {
            sqlx::query(
                "UPDATE phases SET review_verdict='approve', review_reason=NULL
                 WHERE id=? AND review_verdict IS NULL",
            )
            .bind(phase_id)
            .execute(&state.db)
            .await?;
        }
        sqlx::query("UPDATE runs SET status='waiting' WHERE id=?")
            .bind(&phase.run_id)
            .execute(&state.db)
            .await?;
    }

    let detail = run_get_inner(state, &phase.run_id).await?;
    emit_run_updated_for_run(app, state, &phase.run_id).await;
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

    // Approving a submit-phase preview means "create the proposed PR", not
    // "finish the phase". Route to pr_begin_create; the phase finishes only
    // once the agent reports the PR created.
    if phase.kind == "submit" {
        let pr: Option<(String,)> = sqlx::query_as(
            "SELECT status FROM pull_requests WHERE phase_id = ?",
        )
        .bind(&phase_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some((pr_status,)) = pr {
            if pr_status == "draft" || pr_status == "failed" {
                session_runner::pr_begin_create(&app, &state, &phase_id).await?;
                let detail = run_get_inner(&state, &phase.run_id).await?;
                emit_run_updated_for_run(&app, &state, &phase.run_id).await;
                return Ok(detail);
            }
        }
    }

    // Mark the just-completed phase as done, then advance to the next.
    sqlx::query("UPDATE phases SET status='done' WHERE id=?")
        .bind(&phase_id)
        .execute(&state.db)
        .await?;
    let next_id = start_next_phase(&state, &phase.run_id, phase.ord).await?;
    if let Some(id) = next_id {
        session_runner::spawn_for_phase(app.clone(), id);
    }

    let detail = run_get_inner(&state, &phase.run_id).await?;
    emit_run_updated_for_run(&app, &state, &phase.run_id).await;
    Ok(detail)
}

/// Called by the session runner once the agent confirms the PR was created.
/// Marks the submit phase done and advances the run (submit is last, so the
/// run finishes). Safe to call once; no-op if the phase isn't running.
pub async fn finalize_submit_internal(
    app: &AppHandle,
    state: &AppState,
    phase_id: &str,
) -> AppResult<()> {
    let phase = load_phase(state, phase_id).await?;
    if phase.status == "done" {
        return Ok(());
    }
    sqlx::query(
        "UPDATE phases SET status='done', finished_at=datetime('now') WHERE id=?",
    )
    .bind(phase_id)
    .execute(&state.db)
    .await?;
    // Submit is the final phase; this closes out the run.
    let next_id = start_next_phase(state, &phase.run_id, phase.ord).await?;
    if let Some(id) = next_id {
        session_runner::spawn_for_phase(app.clone(), id);
    }
    emit_run_updated_for_run(app, state, &phase.run_id).await;
    Ok(())
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
    // Reset target to running. Also clear any review verdict on this
    // phase and on later phases — they're about to be re-run.
    sqlx::query(
        "UPDATE phases SET status='running', started_at=datetime('now'),
                            finished_at=NULL,
                            review_verdict=NULL, review_reason=NULL, pending_input=NULL
         WHERE id=?",
    )
    .bind(&target.id)
    .execute(&mut *tx)
    .await?;
    // Clear all phases after the target.
    sqlx::query(
        "UPDATE phases SET status='pending', started_at=NULL, finished_at=NULL,
                            review_verdict=NULL, review_reason=NULL, pending_input=NULL
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

    // Cancel anything that might be running for the target's run (e.g. the
    // implementation phase we're rewinding to had a stale runner), then
    // spawn fresh.
    let registry = app.state::<session_runner::RunnerRegistry>();
    let _ = registry.cancel(&target.id);
    session_runner::spawn_for_phase(app.clone(), target.id.clone());

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

/// Handle the reviewer's send-back-to-implementation outcome. Called by
/// session_runner when the review phase completes cleanly AND the agent
/// invoked the `send_back_to_implementation` tool.
///
/// Respects the `review_rewind` gate the same way complete_phase_internal
/// respects the per-phase auto-advance gate: when on, immediately rewinds
/// to the implementation phase; when off, marks review as `waiting` so the
/// user can decide whether to approve or send back via the existing
/// header buttons. Posts a system message into chat either way.
pub async fn review_send_back_internal(
    app: &AppHandle,
    state: &AppState,
    phase_id: &str,
    reason: &str,
) -> AppResult<RunDetail> {
    let phase = load_phase(state, phase_id).await?;
    if phase.status != "running" {
        return run_get_inner(state, &phase.run_id).await;
    }
    let auto = gate_auto_advance(state, "review_rewind").await?;

    // Persist the verdict + reason on the review phase so the UI can
    // show what happened (and re-order action buttons accordingly).
    sqlx::query(
        "UPDATE phases SET review_verdict='request_changes', review_reason=? WHERE id=?",
    )
    .bind(if reason.is_empty() { None } else { Some(reason) })
    .bind(phase_id)
    .execute(&state.db)
    .await?;

    if auto {
        // Mark review done and rewind to the implementation phase.
        sqlx::query(
            "UPDATE phases SET status='done', finished_at=datetime('now') WHERE id=?",
        )
        .bind(phase_id)
        .execute(&state.db)
        .await?;
        let impl_phase: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM phases WHERE run_id = ? AND kind = 'implementation'",
        )
        .bind(&phase.run_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some((impl_id,)) = impl_phase {
            // Reset implementation to running + clear everything after it.
            sqlx::query(
                "UPDATE phases SET status='running', started_at=datetime('now'),
                                    finished_at=NULL WHERE id=?",
            )
            .bind(&impl_id)
            .execute(&state.db)
            .await?;
            sqlx::query(
                "UPDATE phases SET status='pending', started_at=NULL, finished_at=NULL,
                                    review_verdict=NULL, review_reason=NULL, pending_input=NULL
                 WHERE run_id=? AND id != ? AND kind != 'implementation'
                       AND ord > (SELECT ord FROM phases WHERE id = ?)",
            )
            .bind(&phase.run_id)
            .bind(&impl_id)
            .bind(&impl_id)
            .execute(&state.db)
            .await?;
            sqlx::query("UPDATE runs SET status='running', finished_at=NULL WHERE id=?")
                .bind(&phase.run_id)
                .execute(&state.db)
                .await?;
            let summary = if reason.is_empty() {
                "[auto-rewind] Reviewer requested changes; restarting implementation.".to_string()
            } else {
                format!("[auto-rewind] {reason}")
            };
            // Note: we DO NOT persist this message because there's no
            // active session row at this point; the chat already shows
            // the reviewer's send_back tool call. Just spawn the runner.
            let _ = summary;
            session_runner::spawn_for_phase(app.clone(), impl_id);
        }
    } else {
        // Pause for user approval — set review to waiting like a normal gate.
        sqlx::query(
            "UPDATE phases SET status='waiting', finished_at=datetime('now') WHERE id=?",
        )
        .bind(phase_id)
        .execute(&state.db)
        .await?;
        sqlx::query("UPDATE runs SET status='waiting' WHERE id=?")
            .bind(&phase.run_id)
            .execute(&state.db)
            .await?;
    }

    let detail = run_get_inner(state, &phase.run_id).await?;
    emit_run_updated_for_run(app, state, &phase.run_id).await;
    Ok(detail)
}

/// Re-run a failed phase from scratch. Clears the prior sessions/messages
/// for this phase so the chat doesn't accumulate stale interrupted runs,
/// resets the phase + run to `running`, and spawns a fresh sidecar.
#[tauri::command]
pub async fn phase_restart(
    app: AppHandle,
    state: State<'_, AppState>,
    phase_id: String,
) -> AppResult<RunDetail> {
    let target = load_phase(&state, &phase_id).await?;

    if target.status != "failed" && target.status != "cancelled" {
        return Err(AppError::Config(format!(
            "Phase '{}' is in state '{}' — only failed/cancelled phases can be restarted.",
            target.kind, target.status
        )));
    }

    // Best-effort cancel of anything still alive for this phase.
    let registry = app.state::<session_runner::RunnerRegistry>();
    let _ = registry.cancel(&target.id);

    let mut tx = state.db.begin().await?;
    // Wipe prior session messages so the user sees a fresh run, not the
    // stack of interrupted ones. Cascade deletes messages via FK.
    sqlx::query("DELETE FROM sessions WHERE phase_id = ?")
        .bind(&target.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE phases SET status='running', started_at=datetime('now'),
                            finished_at=NULL,
                            review_verdict=NULL, review_reason=NULL, pending_input=NULL
         WHERE id=?",
    )
    .bind(&target.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE runs SET status='running', finished_at=NULL WHERE id=?",
    )
    .bind(&target.run_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let detail = run_get_inner(&state, &target.run_id).await?;
    emit_run_updated_for_run(&app, &state, &target.run_id).await;
    session_runner::spawn_for_phase(app.clone(), target.id.clone());
    Ok(detail)
}

/// Start the phase after `prev_ord`. If there is no next phase, the run is
/// complete and gets marked `done`. Returns the new phase id (if any) so
/// the caller can kick off its session runner.
async fn start_next_phase(state: &AppState, run_id: &str, prev_ord: i64) -> AppResult<Option<String>> {
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
        Ok(Some(next.id))
    } else {
        sqlx::query(
            "UPDATE runs SET status='done', finished_at=datetime('now') WHERE id=?",
        )
        .bind(run_id)
        .execute(&state.db)
        .await?;
        Ok(None)
    }
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
