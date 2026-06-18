//! Worktree management for the implementation/review/submit phases.
//!
//! Conveyer creates a dedicated git worktree (and branch) per run so the agent
//! can commit freely without disturbing the user's checkout. We follow the
//! convention used by `wt`/worktrunk: the worktree lives next to the original
//! checkout as `<repo>.<branch-with-slashes-dashed>`, and the branch is named
//! `<user-alias>/<slug-of-task-title>` where the alias is derived from the
//! repo's git identity.
//!
//! Public entry point: [`ensure_for_run`]. Idempotent — returns the stored
//! worktree path if one already exists on the run row.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Branch prefix used when the user's git identity can't be resolved.
const FALLBACK_ALIAS: &str = "conveyer";

/// Derive a branch-name alias from the repo's git identity, so branches read
/// `<alias>/<task-slug>` for whoever is running the app (not a hardcoded
/// person). Prefers the local-part of `user.email`, then `user.name`; falls
/// back to a generic alias when neither is set.
fn user_alias(codebase: &Path) -> String {
    for key in ["user.email", "user.name"] {
        if let Ok(v) = git_capture(codebase, &["config", key]) {
            let raw = v.split('@').next().unwrap_or("").trim();
            if !raw.is_empty() {
                let slug = slugify(raw);
                if slug != "task" {
                    return slug;
                }
            }
        }
    }
    FALLBACK_ALIAS.to_string()
}

/// Resolve the branch-name alias with precedence: the explicit `branch_alias`
/// setting (ultimate override), then the repo's git identity, then a generic
/// fallback. Always slugified so the result is branch-safe.
async fn resolve_branch_alias(state: &AppState, codebase: &Path) -> String {
    let setting: Option<(String,)> =
        sqlx::query_as("SELECT value FROM settings WHERE key = 'branch_alias'")
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    if let Some((v,)) = setting {
        if !v.trim().is_empty() {
            let slug = slugify(v.trim());
            if slug != "task" {
                return slug;
            }
        }
    }
    user_alias(codebase)
}

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
/// `/Users/x/code/repo` + `alice/foo` -> `/Users/x/code/repo.alice-foo`.
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
///
/// Per-task overrides change behavior:
///   - `tasks.use_worktree = 0` (or global `use_worktree` setting = false)
///     → run directly in `codebase_path`; no `git worktree add`.
///   - `tasks.branch_override = '<existing>'` → check out that existing branch
///     instead of creating `<alias>/<slug>`.
///   - `tasks.base_branch_override = '<branch>'` → use that as the PR base /
///     diff base instead of the auto-detected remote default branch.
pub async fn ensure_for_run(
    state: &AppState,
    run_id: &str,
    task_id: &str,
    task_title: &str,
    codebase_path: &Path,
) -> AppResult<(PathBuf, String, String)> {
    // Per-task overrides.
    let row: Option<(Option<i64>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT use_worktree, base_branch_override, branch_override FROM tasks WHERE id = ?",
    )
    .bind(task_id)
    .fetch_optional(&state.db)
    .await?;
    let (task_use_wt, base_override, branch_override) = row.unwrap_or((None, None, None));
    let global_use_wt: bool = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = 'use_worktree'",
    )
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .map(|v| v != "0" && v.to_ascii_lowercase() != "false")
    .unwrap_or(true);
    let use_wt = task_use_wt.map(|v| v != 0).unwrap_or(global_use_wt);

    // Resolve the base branch + sha. base_override wins; otherwise auto-detect.
    let (auto_base_branch, auto_base_sha) = resolve_base(codebase_path);
    let base_branch = base_override.clone().or(auto_base_branch.clone());
    let base_sha = match (&base_override, &auto_base_branch) {
        (Some(b), Some(a)) if b == a => auto_base_sha.clone(),
        (Some(b), _) => resolve_branch_sha(codebase_path, b).unwrap_or(auto_base_sha.clone()),
        _ => auto_base_sha.clone(),
    };

    // ----- No-worktree path: just use the codebase repo. -----
    if !use_wt {
        // If a branch override is set, switch the repo to it (fails on dirty
        // tree, which is exactly what we want — the user should commit/stash).
        let branch_name = if let Some(ref br) = branch_override {
            let out = Command::new("git")
                .arg("-C").arg(codebase_path)
                .args(["checkout", br])
                .output()
                .map_err(|e| AppError::Other(format!("git checkout: {e}")))?;
            if !out.status.success() {
                return Err(AppError::Other(format!(
                    "git checkout {br} failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim(),
                )));
            }
            br.clone()
        } else {
            git_capture(codebase_path, &["rev-parse", "--abbrev-ref", "HEAD"])
                .unwrap_or_else(|_| "HEAD".to_string())
        };
        sqlx::query(
            "UPDATE runs SET worktree_path = ?, branch_name = ?, base_sha = ?, base_branch = ? WHERE id = ?",
        )
        .bind(codebase_path.to_string_lossy().to_string())
        .bind(&branch_name)
        .bind(&base_sha)
        .bind(base_branch.as_deref())
        .bind(run_id)
        .execute(&state.db)
        .await?;
        return Ok((codebase_path.to_path_buf(), branch_name, base_sha));
    }

    // ----- Worktree path. -----
    let branch = match &branch_override {
        Some(b) => b.clone(),
        None => format!(
            "{}/{}",
            resolve_branch_alias(state, codebase_path).await,
            slugify(task_title)
        ),
    };
    let expected_worktree = worktree_path_for(codebase_path, &branch);

    let existing: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT worktree_path, branch_name, base_sha FROM runs WHERE id = ?",
    )
    .bind(run_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some((Some(wt), Some(br), Some(sha))) = existing {
        if Path::new(&wt).exists() && PathBuf::from(&wt) == expected_worktree && br == branch {
            return Ok((PathBuf::from(wt), br, sha));
        }
    }

    let worktree = expected_worktree;
    if !worktree.exists() {
        // For a new branch (no override): create it on the resolved base SHA.
        // For an existing branch override: just attach a worktree to it.
        let result = if branch_override.is_some() {
            Command::new("git")
                .arg("-C").arg(codebase_path)
                .args(["worktree", "add"])
                .arg(&worktree)
                .arg(&branch)
                .output()
        } else {
            Command::new("git")
                .arg("-C").arg(codebase_path)
                .args(["worktree", "add", "-b"])
                .arg(&branch)
                .arg(&worktree)
                .arg(&base_sha)
                .output()
        };
        let add = result.map_err(|e| AppError::Other(format!("git worktree add: {e}")))?;
        if !add.status.success() {
            let stderr = String::from_utf8_lossy(&add.stderr);
            // If we tried -b and the branch already exists, attach to it instead.
            if branch_override.is_none()
                && (stderr.contains("already exists") || stderr.contains("already used"))
            {
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
                return Err(AppError::Other(format!("git worktree add failed: {stderr}")));
            }
        }
    }

    sqlx::query(
        "UPDATE runs SET worktree_path = ?, branch_name = ?, base_sha = ?, base_branch = ? WHERE id = ?",
    )
    .bind(worktree.to_string_lossy().to_string())
    .bind(&branch)
    .bind(&base_sha)
    .bind(base_branch.as_deref())
    .bind(run_id)
    .execute(&state.db)
    .await?;

    Ok((worktree, branch, base_sha))
}

/// Resolve the tip SHA of an arbitrary branch (local or `origin/<branch>`).
/// Used when the user pins a custom base branch.
fn resolve_branch_sha(codebase: &Path, branch: &str) -> Option<String> {
    let _ = Command::new("git")
        .arg("-C").arg(codebase)
        .args(["fetch", "origin", branch])
        .output();
    let tracking = format!("origin/{branch}");
    git_capture(codebase, &["rev-parse", &tracking])
        .or_else(|_| git_capture(codebase, &["rev-parse", branch]))
        .ok()
}

/// Resolve the remote default branch and ensure we have its latest commit, so
/// every run is cut from up-to-date upstream rather than the user's possibly
/// stale local checkout. Returns `(Some(branch), latest_sha)` when an origin
/// default branch is found; falls back to `(None, local HEAD)` for repos with
/// no usable remote (local-only / demo) so those runs still work unchanged.
///
/// The fetch is best-effort: offline or auth failures degrade to the remote
/// tracking ref if present, else the local HEAD.
fn resolve_base(codebase: &Path) -> (Option<String>, String) {
    let local_head = git_capture(codebase, &["rev-parse", "HEAD"]).unwrap_or_default();
    let Some(branch) = default_remote_branch(codebase) else {
        return (None, local_head);
    };
    let fetched = Command::new("git")
        .arg("-C").arg(codebase)
        .args(["fetch", "origin", &branch])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let tracking = format!("origin/{branch}");
    let sha = if fetched {
        git_capture(codebase, &["rev-parse", "FETCH_HEAD"])
            .or_else(|_| git_capture(codebase, &["rev-parse", &tracking]))
            .unwrap_or_else(|_| local_head.clone())
    } else {
        git_capture(codebase, &["rev-parse", &tracking]).unwrap_or_else(|_| local_head.clone())
    };
    (Some(branch), sha)
}

/// Best-effort lookup of origin's default branch name (e.g. "main").
/// Prefers the local `origin/HEAD` symref (fast, no network); falls back to
/// `git remote show origin` (network) for remotes added manually without a
/// HEAD symref. Returns None when there's no origin.
fn default_remote_branch(codebase: &Path) -> Option<String> {
    if let Ok(s) = git_capture(codebase, &["symbolic-ref", "refs/remotes/origin/HEAD"]) {
        if let Some(name) = s.rsplit('/').next() {
            let name = name.trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    if let Ok(s) = git_capture(codebase, &["remote", "show", "origin"]) {
        for line in s.lines() {
            if let Some(rest) = line.trim().strip_prefix("HEAD branch:") {
                let name = rest.trim();
                if !name.is_empty() && name != "(unknown)" {
                    return Some(name.to_string());
                }
            }
        }
    }
    None
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

    #[test]
    fn resolve_base_returns_latest_upstream() {
        use std::process::Command;
        let root = std::env::temp_dir().join(format!("conveyer-base-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let remote = root.join("remote.git");
        let a = root.join("a");
        let b = root.join("b");
        let git = |dir: &Path, args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
            assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        // Bare remote with a `main` default branch.
        let out = Command::new("git")
            .args(["init", "--bare", "-b", "main"])
            .arg(&remote)
            .output()
            .unwrap();
        assert!(out.status.success());

        // Clone A, seed first commit, push to remote/main.
        assert!(Command::new("git").args(["clone", "-q"]).arg(&remote).arg(&a).output().unwrap().status.success());
        git(&a, &["config", "user.email", "t@t.com"]);
        git(&a, &["config", "user.name", "T"]);
        std::fs::write(a.join("f"), "1").unwrap();
        git(&a, &["add", "."]);
        git(&a, &["commit", "-q", "-m", "c1"]);
        git(&a, &["push", "-q", "origin", "main"]);

        // Clone B (this is our "user checkout"): now origin/HEAD -> main and
        // local main == c1.
        assert!(Command::new("git").args(["clone", "-q"]).arg(&remote).arg(&b).output().unwrap().status.success());
        let stale = git(&b, &["rev-parse", "HEAD"]);

        // Upstream advances via A: push c2. B's local main is now stale.
        std::fs::write(a.join("f"), "2").unwrap();
        git(&a, &["add", "."]);
        git(&a, &["commit", "-q", "-m", "c2"]);
        git(&a, &["push", "-q", "origin", "main"]);
        let latest = git(&a, &["rev-parse", "HEAD"]);

        let (branch, sha) = resolve_base(&b);
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(sha, latest, "should resolve the up-to-date upstream tip, not stale local");
        assert_ne!(sha, stale);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_base_no_remote_falls_back_to_head() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("conveyer-noremote-{}", std::process::id()));
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
        git(&["commit", "-q", "-m", "only"]);
        let head = git(&["rev-parse", "HEAD"]);

        let (branch, sha) = resolve_base(&dir);
        assert_eq!(branch, None);
        assert_eq!(sha, head);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_alias_from_git_identity_and_fallback() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("conveyer-alias-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let set = |k: &str, v: &str| {
            assert!(Command::new("git").arg("-C").arg(&dir).args(["config", k, v]).output().unwrap().status.success());
        };
        assert!(Command::new("git").arg("-C").arg(&dir).args(["init", "-q"]).output().unwrap().status.success());
        // Local-part of the email wins, sanitized.
        set("user.email", "Alice.Smith@example.com");
        assert_eq!(user_alias(&dir), "alice-smith");
        // With an empty local email (overrides global), fall back to user.name.
        set("user.email", "");
        set("user.name", "Bob Jones");
        assert_eq!(user_alias(&dir), "bob-jones");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn branch_alias_setting_overrides_git_identity() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("conveyer-aliasovr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            assert!(Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap().status.success());
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "someone@example.com"]);

        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
            .execute(&pool).await.unwrap();
        let state = AppState::new(pool);

        // No setting -> derives from git identity.
        assert_eq!(resolve_branch_alias(&state, &dir).await, "someone");

        // Setting present -> it wins (slugified).
        sqlx::query("INSERT INTO settings(key, value) VALUES('branch_alias', 'Team Rocket')")
            .execute(&state.db).await.unwrap();
        assert_eq!(resolve_branch_alias(&state, &dir).await, "team-rocket");

        // Blank setting -> falls back to git identity again.
        sqlx::query("UPDATE settings SET value='' WHERE key='branch_alias'")
            .execute(&state.db).await.unwrap();
        assert_eq!(resolve_branch_alias(&state, &dir).await, "someone");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
