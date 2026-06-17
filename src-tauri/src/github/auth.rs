//! Resolves a GitHub API token for a source, dispatching on the source's
//! auth kind: a token from the `gh` CLI (reuses the user's existing login,
//! including SSO), or a PAT read from an env var.

use crate::error::{AppError, AppResult};
use tokio::process::Command;

#[derive(Debug, Clone, Copy)]
pub enum GithubAuthKind {
    /// Token via the GitHub CLI (`gh auth token`). Default.
    Gh,
    /// Personal access token read from an env var.
    Pat,
}

impl GithubAuthKind {
    pub fn parse(s: &str) -> GithubAuthKind {
        match s {
            "pat" => GithubAuthKind::Pat,
            // Treat anything else (incl. "gh", "entra", "") as the gh path —
            // it's the sensible default for GitHub sources.
            _ => GithubAuthKind::Gh,
        }
    }
}

/// Resolve a raw GitHub token (no `Bearer ` prefix). The caller adds it.
pub async fn token(kind: GithubAuthKind, pat_env: &str) -> AppResult<String> {
    match kind {
        GithubAuthKind::Pat => std::env::var(pat_env)
            .map_err(|_| AppError::Config(format!("env var {pat_env} not set")))
            .map(|v| v.trim().to_string()),
        GithubAuthKind::Gh => gh_token().await,
    }
}

async fn gh_token() -> AppResult<String> {
    let out = Command::new("gh")
        .args(["auth", "token"])
        .output()
        .await
        .map_err(|e| {
            AppError::Config(format!(
                "could not run `gh` (is the GitHub CLI installed and on PATH?): {e}"
            ))
        })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::Config(format!(
            "`gh auth token` failed (run `gh auth login`): {}",
            err.trim()
        )));
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if token.is_empty() {
        return Err(AppError::Config(
            "`gh auth token` returned nothing; run `gh auth login`.".into(),
        ));
    }
    Ok(token)
}
