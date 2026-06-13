//! Worktree metadata for the implementation/review/submit phases.
//!
//! Conveyer doesn't create the worktree itself — the agent does, per the
//! implementation-phase prompt. What we record here is the *expected* branch
//! name + worktree path (derived deterministically from the task title) and
//! the base SHA at impl-phase start, so the Diff tab knows where to look and
//! what to diff against.
//!
//! Public entry point: [`record_for_run`].

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

/// Derive the worktree directory we tell the agent to create.
/// `/Users/x/code/repo` + `abdulasfari/foo` -> `/Users/x/code/repo.abdulasfari-foo`.
/// Matches the worktrunk convention.
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

/// Record the expected branch + worktree path + base SHA for this run.
/// Idempotent: if already recorded, returns the stored values unchanged so
/// review/submit phases see the same metadata implementation set up.
pub async fn record_for_run(
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
    if let Some((Some(wt), Some(br), Some(sha))) = existing {
        return Ok((PathBuf::from(wt), br, sha));
    }

    let branch = format!("{BRANCH_PREFIX}{}", slugify(task_title));
    let worktree = worktree_path_for(codebase_path, &branch);
    let base_sha = git_capture(codebase_path, &["rev-parse", "HEAD"])
        .unwrap_or_else(|_| String::new());

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
