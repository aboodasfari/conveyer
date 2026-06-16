//! Pull-request preview for the submit phase.
//!
//! Flow: the submit phase agent DRAFTS a PR (status='draft') via the
//! `propose_pr` sidecar tool; we show it as a preview. On the user's
//! approval (`pr_create`) the warm sidecar is resumed with an
//! instruction to actually create the PR; the agent reports back via
//! the `pr_created` tool (status='created'|'failed').

use crate::error::{AppError, AppResult};
use crate::session_runner;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PullRequest {
    pub phase_id: String,
    pub title: String,
    pub source_branch: Option<String>,
    pub target_branch: Option<String>,
    pub description: Option<String>,
    pub status: String,
    pub number: Option<i64>,
    pub url: Option<String>,
    pub checks_json: Option<String>,
    pub reviewers_json: Option<String>,
    pub work_items_json: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const PR_COLS: &str = "phase_id, title, source_branch, target_branch, description, status, \
    number, url, checks_json, reviewers_json, work_items_json, error, created_at, updated_at";

#[tauri::command]
pub async fn pull_request_for_phase(
    state: State<'_, AppState>,
    phase_id: String,
) -> AppResult<Option<PullRequest>> {
    let row = sqlx::query_as::<_, PullRequest>(&format!(
        "SELECT {PR_COLS} FROM pull_requests WHERE phase_id = ?"
    ))
    .bind(&phase_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row)
}

/// Approve the drafted PR: resume the agent to actually create it.
#[tauri::command]
pub async fn pr_create(
    app: AppHandle,
    state: State<'_, AppState>,
    phase_id: String,
) -> AppResult<()> {
    let pr = sqlx::query_as::<_, PullRequest>(&format!(
        "SELECT {PR_COLS} FROM pull_requests WHERE phase_id = ?"
    ))
    .bind(&phase_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(pr) = pr else {
        return Err(AppError::Config("No drafted pull request to create.".into()));
    };
    if pr.status == "creating" {
        return Err(AppError::Config("The pull request is already being created.".into()));
    }
    if pr.status == "created" {
        return Err(AppError::Config("The pull request has already been created.".into()));
    }
    session_runner::pr_begin_create(&app, &state, &phase_id).await
}
