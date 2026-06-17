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

/// Strip internal `[conveyer-comment:...]` markers from commit messages on
/// `base_sha..HEAD` in the given worktree. The markers are an internal device
/// (they let the review agent locate and amend the commit for a given comment
/// thread); they must never reach the remote. We scrub them deterministically
/// in Rust right before the PR push so the public history stays clean no matter
/// how the agent behaves or how ADO squashes/merges the PR.
///
/// Author and committer identity and dates are preserved (verified); only the
/// message text and resulting commit SHAs change. No-op if no commit in range
/// carries a marker, so unaffected runs keep their original SHAs.
pub fn strip_comment_markers(worktree: &Path, base_sha: &str) -> AppResult<()> {
    let range = format!("{base_sha}..HEAD");
    // Fast path: nothing to do unless a marker is actually present.
    let bodies = git_capture(worktree, &["log", "--format=%B", &range])?;
    if !bodies.contains("[conveyer-comment:") {
        return Ok(());
    }

    // `git filter-branch --msg-filter` rewrites messages while keeping author
    // and committer name/email/date intact. The sed drops the marker token
    // (and any leading spaces) wherever it appears.
    let out = Command::new("git")
        .arg("-C").arg(worktree)
        .env("FILTER_BRANCH_SQUELCH_WARNING", "1")
        .args([
            "filter-branch",
            "-f",
            "--msg-filter",
            r"sed -e 's/ *\[conveyer-comment:[^]]*\]//g'",
            "--",
            &range,
        ])
        .output()
        .map_err(|e| AppError::Other(format!("git filter-branch: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Other(format!(
            "git filter-branch failed: {}",
            String::from_utf8_lossy(&out.stderr),
        )));
    }

    // filter-branch leaves a backup under refs/original/. Remove it so the
    // worktree's history isn't pinned to the pre-scrub commits.
    if let Ok(refs) = git_capture(worktree, &["for-each-ref", "--format=%(refname)", "refs/original/"]) {
        for r in refs.lines().filter(|l| !l.trim().is_empty()) {
            let _ = Command::new("git")
                .arg("-C").arg(worktree)
                .args(["update-ref", "-d", r])
                .output();
        }
    }
    Ok(())
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

    #[test]
    fn strip_markers_preserves_dates_and_clears_marker() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("conveyer-strip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str], env: &[(&str, &str)]| {
            let mut c = Command::new("git");
            c.arg("-C").arg(&dir).args(args);
            for (k, v) in env {
                c.env(k, v);
            }
            let out = c.output().unwrap();
            assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q"], &[]);
        git(&["config", "user.email", "t@t.com"], &[]);
        git(&["config", "user.name", "T"], &[]);
        std::fs::write(dir.join("a"), "a").unwrap();
        git(&["add", "."], &[]);
        // Base commit (no marker) — this is the worktree's starting point.
        git(&["commit", "-q", "-m", "base"], &[
            ("GIT_AUTHOR_DATE", "2020-01-01T10:00:00"),
            ("GIT_COMMITTER_DATE", "2020-01-01T11:00:00"),
        ]);
        let base = git(&["rev-parse", "HEAD"], &[]);
        // Agent commit carrying a marker.
        std::fs::write(dir.join("b"), "b").unwrap();
        git(&["add", "."], &[]);
        git(&["commit", "-q", "-m", "do the thing [conveyer-comment:abc123]"], &[
            ("GIT_AUTHOR_DATE", "2021-06-15T09:30:00"),
            ("GIT_COMMITTER_DATE", "2021-06-15T12:45:00"),
        ]);
        let author_before = git(&["log", "-1", "--format=%aI"], &[]);
        let committer_before = git(&["log", "-1", "--format=%cI"], &[]);

        strip_comment_markers(&dir, &base).unwrap();

        let subject = git(&["log", "-1", "--format=%s"], &[]);
        assert!(!subject.contains("conveyer-comment"), "marker not stripped: {subject}");
        assert_eq!(subject, "do the thing");
        assert_eq!(git(&["log", "-1", "--format=%aI"], &[]), author_before, "author date changed");
        assert_eq!(git(&["log", "-1", "--format=%cI"], &[]), committer_before, "committer date changed");
        // Backup ref cleaned up.
        assert_eq!(git(&["for-each-ref", "refs/original/"], &[]), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn strip_markers_noop_without_marker() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("conveyer-noop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap();
            assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(dir.join("a"), "a").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "base"]);
        let base = git(&["rev-parse", "HEAD"]);
        std::fs::write(dir.join("b"), "b").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "clean commit"]);
        let head_before = git(&["rev-parse", "HEAD"]);

        strip_comment_markers(&dir, &base).unwrap();

        // No marker present -> SHAs untouched.
        assert_eq!(git(&["rev-parse", "HEAD"]), head_before);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
