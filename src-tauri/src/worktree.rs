//! Worktree management for the implementation/review/submit phases.
//!
//! Conveyer creates a dedicated git worktree (and branch) per run so the agent
//! can commit freely without disturbing the user's checkout. We follow the
//! convention used by `wt`/worktrunk: the worktree lives next to the original
//! checkout as `<repo>.<branch-with-slashes-dashed>`, and the branch is named
//! `abdulasfari/<slug-of-task-title>`.
//!
//! Public entry point: [`ensure_for_run`]. Idempotent — returns the stored
//! worktree path if one already exists on the run row.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const BRANCH_PREFIX: &str = "abdulasfari/";

/// Convert a free-form task title to a branch-safe slug.
/// Lowercase, alphanumerics + dashes only, collapsed, max 48 chars.
pub fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut last_dash = true; // suppress leading dash
    for ch in title.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out.push_str("task");
    }
    out.chars().take(48).collect::<String>().trim_end_matches('-').to_string()
}

/// Derive the worktree directory for a given codebase + branch.
/// `/Users/x/code/repo` + `abdulasfari/foo` -> `/Users/x/code/repo.abdulasfari-foo`.
pub fn worktree_path_for(codebase: &Path, branch: &str) -> PathBuf {
    let dashed = branch.replace('/', "-");
    let basename = codebase
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into());
    let mut p = codebase.to_path_buf();
    p.pop();
    p.push(format!("{basename}.{dashed}"));
    p
}

/// Ensure a worktree exists for this run. Returns (worktree_path, branch_name,
/// base_sha). Idempotent: if the run row already records a worktree AND the
/// directory still exists on disk, returns those values without touching git.
pub async fn ensure_for_run(
    state: &AppState,
    run_id: &str,
    task_title: &str,
    codebase_path: &Path,
) -> AppResult<(PathBuf, String, String)> {
    let existing: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT worktree_path, branch_name, base_sha FROM runs WHERE id = ?",
    )
    .bind(run_id)
    .fetch_optional(&state.db)
    .await?;
    let branch = format!("{BRANCH_PREFIX}{}", slugify(task_title));
    let expected_worktree = worktree_path_for(codebase_path, &branch);

    if let Some((Some(wt), Some(br), Some(sha))) = existing {
        // Only reuse if the recorded worktree is the one we'd create now
        // for this codebase + branch AND it still exists on disk. Otherwise
        // it's stale (e.g. the task's workspace was changed since the
        // last run) — fall through and recompute.
        if Path::new(&wt).exists() && PathBuf::from(&wt) == expected_worktree {
            return Ok((PathBuf::from(wt), br, sha));
        }
    }

    let worktree = expected_worktree;
    let base_sha = git_capture(codebase_path, &["rev-parse", "HEAD"])?;

    if !worktree.exists() {
        // Try to add the worktree with a new branch. If the branch already
        // exists (e.g. a previous run), re-attach to it instead.
        let add_with_branch = Command::new("git")
            .arg("-C").arg(codebase_path)
            .args(["worktree", "add", "-b"])
            .arg(&branch)
            .arg(&worktree)
            .arg(&base_sha)
            .output()
            .map_err(|e| AppError::Other(format!("git worktree add: {e}")))?;
        if !add_with_branch.status.success() {
            let stderr = String::from_utf8_lossy(&add_with_branch.stderr);
            if stderr.contains("already exists") || stderr.contains("already used") {
                let again = Command::new("git")
                    .arg("-C").arg(codebase_path)
                    .args(["worktree", "add"])
                    .arg(&worktree)
                    .arg(&branch)
                    .output()
                    .map_err(|e| AppError::Other(format!("git worktree add (retry): {e}")))?;
                if !again.status.success() {
                    return Err(AppError::Other(format!(
                        "git worktree add failed: {}",
                        String::from_utf8_lossy(&again.stderr),
                    )));
                }
            } else {
                return Err(AppError::Other(format!(
                    "git worktree add failed: {stderr}",
                )));
            }
        }
    }

    sqlx::query(
        "UPDATE runs SET worktree_path = ?, branch_name = ?, base_sha = ? WHERE id = ?",
    )
    .bind(worktree.to_string_lossy().to_string())
    .bind(&branch)
    .bind(&base_sha)
    .bind(run_id)
    .execute(&state.db)
    .await?;

    Ok((worktree, branch, base_sha))
}

/// Run `git -C <dir> <args>` and return trimmed stdout.
pub fn git_capture(dir: &Path, args: &[&str]) -> AppResult<String> {
    let out = Command::new("git")
        .arg("-C").arg(dir)
        .args(args)
        .output()
        .map_err(|e| AppError::Other(format!("git {}: {e}", args.join(" "))))?;
    if !out.status.success() {
        return Err(AppError::Other(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr),
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slug_basic() {
        assert_eq!(slugify("Fix add() float handling"), "fix-add-float-handling");
        assert_eq!(slugify("   $$$   "), "task");
        assert_eq!(slugify("Hello---World!!"), "hello-world");
    }
    #[test]
    fn slug_truncates() {
        let s = slugify(&"a".repeat(200));
        assert_eq!(s.len(), 48);
    }
}
