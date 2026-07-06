//! Diff browsing commands. Backed by `git -C <worktree>` invocations against
//! the per-run worktree captured at implementation-phase start.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::worktree::git_capture;

#[derive(Serialize)]
pub struct CommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    pub ts: String,
}

#[derive(Serialize)]
pub struct DiffSummary {
    pub branch: String,
    pub base_sha: String,
    pub head_sha: String,
    pub worktree_path: String,
    pub commits: Vec<CommitInfo>,
    /// True when a `worktree_path` was recorded for this run but the
    /// directory no longer exists on disk (typically because the user
    /// removed it externally). The frontend renders a stable placeholder
    /// for this state instead of a hard error so the Diff tab doesn't
    /// flicker on the background poll.
    pub worktree_missing: bool,
}

async fn worktree_for_phase(
    state: &AppState,
    phase_id: &str,
) -> AppResult<Option<(String, String, Option<String>)>> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT r.worktree_path, r.base_sha, r.branch_name
         FROM phases p JOIN runs r ON r.id = p.run_id
         WHERE p.id = ?",
    )
    .bind(phase_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(match row {
        Some((Some(wt), Some(base), branch)) => Some((wt, base, branch)),
        _ => None,
    })
}

#[tauri::command]
pub async fn phase_diff_summary(
    state: State<'_, AppState>,
    phase_id: String,
) -> AppResult<Option<DiffSummary>> {
    let Some((worktree, base_sha, branch_db)) = worktree_for_phase(&state, &phase_id).await? else {
        return Ok(None);
    };
    let wt = std::path::Path::new(&worktree);

    // Worktree recorded but gone from disk (user deleted it externally,
    // pruned it, moved the repo, etc.). Treat as an expected state and
    // return a stable "empty" summary flagged as missing — no git calls,
    // no error propagation, no flicker on the background poll.
    if !wt.exists() {
        return Ok(Some(DiffSummary {
            branch: branch_db.unwrap_or_default(),
            base_sha,
            head_sha: String::new(),
            worktree_path: worktree,
            commits: Vec::new(),
            worktree_missing: true,
        }));
    }

    let head_sha = git_capture(wt, &["rev-parse", "HEAD"])?;
    let branch = git_capture(wt, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();

    // Commits from base (exclusive) to HEAD, oldest first.
    let log = if head_sha == base_sha {
        String::new()
    } else {
        let range = format!("{base_sha}..HEAD");
        git_capture(
            wt,
            &["log", "--reverse", "--pretty=%H%x09%h%x09%an%x09%cI%x09%s", &range],
        )
        .unwrap_or_default()
    };

    let mut commits = Vec::new();
    for line in log.lines() {
        let parts: Vec<&str> = line.splitn(5, '\t').collect();
        if parts.len() == 5 {
            commits.push(CommitInfo {
                sha: parts[0].to_string(),
                short_sha: parts[1].to_string(),
                author: parts[2].to_string(),
                ts: parts[3].to_string(),
                subject: parts[4].to_string(),
            });
        }
    }

    Ok(Some(DiffSummary {
        branch,
        base_sha,
        head_sha,
        worktree_path: worktree,
        commits,
        worktree_missing: false,
    }))
}

/// Raw unified diff text. If `commit` is `None`, returns the overall diff
/// `base..HEAD`. If `Some(sha)`, returns the diff of just that commit.
/// Capped at ~2 MB to keep the UI responsive.
#[tauri::command]
pub async fn phase_diff_text(
    state: State<'_, AppState>,
    phase_id: String,
    commit: Option<String>,
) -> AppResult<String> {
    let Some((worktree, base_sha, _branch)) = worktree_for_phase(&state, &phase_id).await? else {
        return Ok(String::new());
    };
    let wt = std::path::Path::new(&worktree);
    // Same "missing" short-circuit as the summary: no error, empty diff.
    if !wt.exists() {
        return Ok(String::new());
    }

    let out = match commit.as_deref() {
        Some(sha) => git_capture(wt, &["show", "--no-color", "-U99999", "--patch-with-stat", sha])?,
        None => {
            let range = format!("{base_sha}..HEAD");
            git_capture(wt, &["diff", "--no-color", "-U99999", "--patch-with-stat", &range])?
        }
    };

    const CAP: usize = 2 * 1024 * 1024;
    if out.len() > CAP {
        let mut truncated = out.chars().take(CAP).collect::<String>();
        truncated.push_str("\n\n…[diff truncated]…\n");
        return Ok(truncated);
    }
    Ok(out)
}

/// Recreate the on-disk worktree for the run this phase belongs to. Called
/// from the Diff tab's "worktree missing" placeholder. Reuses the same
/// `worktree::ensure_for_run` path that phase-start uses, so branch
/// resolution, base-sha lookup, and DB updates all match. Translates the
/// "branch is checked out at another live worktree" case into a friendly
/// error the UI can surface without a stack-trace.
#[tauri::command]
pub async fn run_worktree_recreate(
    app: AppHandle,
    state: State<'_, AppState>,
    phase_id: String,
) -> AppResult<()> {
    let (ctx, run_id, _phase_kind) =
        crate::session_runner::load_phase_context(&state, &phase_id).await?;
    let codebase = std::path::Path::new(&ctx.codebase_path);

    match crate::worktree::ensure_for_run(
        &state,
        &run_id,
        &ctx.task_id,
        &ctx.task_title,
        codebase,
    )
    .await
    {
        Ok(_) => {
            crate::commands::runs::emit_run_updated_for_run(&app, &state, &run_id).await;
            Ok(())
        }
        Err(e) => {
            // `git worktree add` uses these phrases when the target branch
            // is checked out somewhere we don't own (a live linked worktree
            // in this repo). Prune already ran inside ensure_for_run, so if
            // we still get here the conflict is real — don't force it.
            let msg = e.to_string();
            let lower = msg.to_ascii_lowercase();
            if lower.contains("is already checked out")
                || lower.contains("already used by worktree")
            {
                Err(AppError::Config(format!(
                    "Can't recreate: the branch is already checked out in another worktree. \
                     Close that worktree (or remove it with `git worktree remove`) and try again. \
                     Details: {msg}"
                )))
            } else {
                Err(e)
            }
        }
    }
}
