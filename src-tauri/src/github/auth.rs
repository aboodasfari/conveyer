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
/// `host` is the bare GitHub host (e.g. "github.acme.com"); None = github.com.
pub async fn token(kind: GithubAuthKind, pat_env: &str, host: Option<&str>) -> AppResult<String> {
    match kind {
        GithubAuthKind::Pat => std::env::var(pat_env)
            .map_err(|_| AppError::Config(format!("env var {pat_env} not set")))
            .map(|v| v.trim().to_string()),
        GithubAuthKind::Gh => gh_token(host).await,
    }
}

async fn gh_token(host: Option<&str>) -> AppResult<String> {
    let mut cmd = Command::new("gh");
    cmd.args(["auth", "token"]);
    // Pin the host so Enterprise users get the right instance's token rather
    // than whatever account happens to be active on github.com.
    if let Some(h) = host.map(str::trim).filter(|h| !h.is_empty()) {
        cmd.args(["--hostname", h]);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| {
            AppError::Config(format!(
                "could not run `gh` (is the GitHub CLI installed and on PATH?): {e}"
            ))
        })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let hint = match host.map(str::trim).filter(|h| !h.is_empty()) {
            Some(h) => format!("run `gh auth login --hostname {h}`"),
            None => "run `gh auth login`".to_string(),
        };
        return Err(AppError::Config(format!(
            "`gh auth token` failed ({hint}): {}",
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
