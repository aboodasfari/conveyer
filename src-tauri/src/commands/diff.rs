//! Diff browsing commands. Backed by `git -C <worktree>` invocations against
//! the per-run worktree captured at implementation-phase start.

use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
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
}

async fn worktree_for_phase(state: &AppState, phase_id: &str) -> AppResult<Option<(String, String)>> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT r.worktree_path, r.base_sha
         FROM phases p JOIN runs r ON r.id = p.run_id
         WHERE p.id = ?",
    )
    .bind(phase_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(match row {
        Some((Some(wt), Some(base))) => Some((wt, base)),
        _ => None,
    })
}

#[tauri::command]
pub async fn phase_diff_summary(
    state: State<'_, AppState>,
    phase_id: String,
) -> AppResult<Option<DiffSummary>> {
    let Some((worktree, base_sha)) = worktree_for_phase(&state, &phase_id).await? else {
        return Ok(None);
    };
    let wt = std::path::Path::new(&worktree);
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
    let Some((worktree, base_sha)) = worktree_for_phase(&state, &phase_id).await? else {
        return Ok(String::new());
    };
    let wt = std::path::Path::new(&worktree);

    let out = match commit.as_deref() {
        Some(sha) => git_capture(wt, &["show", "--no-color", "--patch-with-stat", sha])?,
        None => {
            let range = format!("{base_sha}..HEAD");
            git_capture(wt, &["diff", "--no-color", "--patch-with-stat", &range])?
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
