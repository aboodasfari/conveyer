//! Resolves an ADO Authorization header value for a source, dispatching on
//! the source's auth kind: PAT from an env var, or a bearer token from `az`.

use crate::error::{AppError, AppResult};
use base64::Engine;
use serde::Deserialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::process::Command;

/// Canonical Azure DevOps app id used as the resource for token acquisition.
const ADO_RESOURCE: &str = "499b84ac-1321-427f-aa17-267ca6975798";

#[derive(Debug, Clone, Copy)]
pub enum AuthKind {
    Pat,
    Entra,
}

impl AuthKind {
    pub fn parse(s: &str) -> AuthKind {
        match s {
            "entra" => AuthKind::Entra,
            _ => AuthKind::Pat,
        }
    }
}

pub struct AuthInputs<'a> {
    pub kind: AuthKind,
    pub pat_env: &'a str,
    pub az_account: &'a str, // empty = default
}

pub async fn header_value(inputs: AuthInputs<'_>) -> AppResult<String> {
    match inputs.kind {
        AuthKind::Pat => {
            let pat = std::env::var(inputs.pat_env).map_err(|_| {
                AppError::Config(format!("env var {} not set", inputs.pat_env))
            })?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(format!(":{pat}"));
            Ok(format!("Basic {b64}"))
        }
        AuthKind::Entra => {
            let token = entra_token(inputs.az_account).await?;
            Ok(format!("Bearer {token}"))
        }
    }
}

#[derive(Debug, Deserialize)]
struct AzTokenOut {
    #[serde(rename = "accessToken")]
    access_token: String,
}

/// Cached entra token keyed on subscription (empty = default).
static TOKEN_CACHE: Mutex<Option<CachedToken>> = Mutex::new(None);

struct CachedToken {
    account: String,
    token: String,
    fetched_at: Instant,
}

async fn entra_token(account: &str) -> AppResult<String> {
    // Cache for 30 minutes — az tokens are usually valid ~1h but we refresh
    // generously to stay clear of clock skew / preemptive rotation.
    if let Some(c) = TOKEN_CACHE.lock().unwrap().as_ref() {
        if c.account == account && c.fetched_at.elapsed() < Duration::from_secs(30 * 60) {
            return Ok(c.token.clone());
        }
    }

    let mut cmd = Command::new("az");
    cmd.args([
        "account",
        "get-access-token",
        "--resource",
        ADO_RESOURCE,
        "-o",
        "json",
    ]);
    if !account.is_empty() {
        cmd.args(["--subscription", account]);
    }
    let out = cmd.output().await.map_err(|e| {
        AppError::Config(format!(
            "could not run `az` (is Azure CLI installed and on PATH?): {e}"
        ))
    })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::Config(format!(
            "az get-access-token failed: {}",
            err.trim()
        )));
    }
    let parsed: AzTokenOut = serde_json::from_slice(&out.stdout)?;
    *TOKEN_CACHE.lock().unwrap() = Some(CachedToken {
        account: account.to_string(),
        token: parsed.access_token.clone(),
        fetched_at: Instant::now(),
    });
    Ok(parsed.access_token)
}
