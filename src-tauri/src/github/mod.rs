//! Minimal GitHub REST client.
//! Only what Conveyer needs: list issues assigned to the authenticated user
//! and fetch one issue by id, plus a cheap auth/access probe.

pub mod auth;

use crate::error::{AppError, AppResult};
use crate::models::GithubSourceConfig;
use serde::Deserialize;
use serde_json::Value;

const API_BASE: &str = "https://api.github.com";
/// Hard cap on Search API pages (100/page) so a noisy account can't spin
/// forever. 5 pages = up to 500 assigned issues, far more than realistic.
const MAX_PAGES: u32 = 5;

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("conveyer/0.1")
        .build()
        .expect("reqwest client build")
}

fn auth_header(token: &str) -> String {
    format!("Bearer {token}")
}

/// Surface a useful error excerpt — GitHub returns a JSON `message` for most
/// failures (bad creds, rate limit, validation).
async fn check(resp: reqwest::Response, ctx: &str) -> AppResult<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_else(|| {
            let t = body.trim();
            if t.len() > 240 { format!("{}…", &t[..240]) } else { t.to_string() }
        });
    Err(AppError::Other(format!("{ctx}: HTTP {status} — {msg}")))
}

#[derive(Debug, Clone)]
pub struct GithubIssue {
    pub number: i64,
    pub repo_full_name: String, // "owner/repo"
    pub title: String,
    pub state: String, // "open" | "closed"
    pub body: Option<String>,
    pub html_url: String,
}

impl GithubIssue {
    /// Stable, unique-per-source identifier: "owner/repo#number".
    pub fn source_ref(&self) -> String {
        format!("{}#{}", self.repo_full_name, self.number)
    }
}

#[derive(Debug, Deserialize)]
struct SearchResult {
    items: Vec<RawIssue>,
}

#[derive(Debug, Deserialize)]
struct RawIssue {
    number: i64,
    title: String,
    state: String,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    /// e.g. "https://api.github.com/repos/owner/repo/issues/1" — we derive the
    /// repo full name from it (the search payload has no clean repo object).
    repository_url: String,
    /// Present on PRs only; lets us exclude them defensively.
    #[serde(default)]
    pull_request: Option<Value>,
}

/// Derive "owner/repo" from a repository API url like
/// `https://api.github.com/repos/owner/repo`.
fn repo_full_name(repository_url: &str) -> Option<String> {
    let marker = "/repos/";
    let idx = repository_url.find(marker)? + marker.len();
    let rest = &repository_url[idx..];
    let mut parts = rest.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

fn raw_to_issue(raw: RawIssue) -> Option<GithubIssue> {
    // Exclude pull requests — we only track issues.
    if raw.pull_request.is_some() {
        return None;
    }
    let repo_full_name = repo_full_name(&raw.repository_url)?;
    Some(GithubIssue {
        number: raw.number,
        repo_full_name,
        title: raw.title,
        state: raw.state,
        body: raw.body,
        html_url: raw.html_url,
    })
}

/// Keep only issues whose repo owner matches `cfg.owner` (case-insensitive),
/// and—if set—whose repo matches `cfg.repo`. Filtering client-side sidesteps
/// the GitHub `user:` vs `org:` search-qualifier ambiguity.
fn matches_scope(issue: &GithubIssue, cfg: &GithubSourceConfig) -> bool {
    let mut parts = issue.repo_full_name.split('/');
    let owner = parts.next().unwrap_or("");
    let repo = parts.next().unwrap_or("");
    if !owner.eq_ignore_ascii_case(&cfg.owner) {
        return false;
    }
    match cfg.repo.as_deref() {
        Some(r) if !r.is_empty() => repo.eq_ignore_ascii_case(r),
        _ => true,
    }
}

/// Issues assigned to the authenticated user, scoped to the source's owner
/// (and repo, if set). Open issues only.
pub async fn fetch_assigned_issues(
    cfg: &GithubSourceConfig,
    token: &str,
) -> AppResult<Vec<GithubIssue>> {
    let c = client();
    let mut out = Vec::new();
    for page in 1..=MAX_PAGES {
        let url = format!(
            "{API_BASE}/search/issues?q=assignee:@me+is:issue+is:open&per_page=100&page={page}"
        );
        let resp = c
            .get(&url)
            .header("Authorization", auth_header(token))
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?;
        let resp = check(resp, "search assigned issues").await?;
        let result: SearchResult = resp.json().await?;
        let count = result.items.len();
        for raw in result.items {
            if let Some(issue) = raw_to_issue(raw) {
                if matches_scope(&issue, cfg) {
                    out.push(issue);
                }
            }
        }
        // The last page is shorter than the page size.
        if count < 100 {
            break;
        }
    }
    Ok(out)
}

/// Fetch a single issue by owner/repo/number (for add-by-url).
pub async fn fetch_issue(
    token: &str,
    owner: &str,
    repo: &str,
    number: i64,
) -> AppResult<GithubIssue> {
    let url = format!("{API_BASE}/repos/{owner}/{repo}/issues/{number}");
    let resp = client()
        .get(&url)
        .header("Authorization", auth_header(token))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    let resp = check(resp, &format!("fetch issue {owner}/{repo}#{number}")).await?;
    let raw: RawIssue = resp.json().await?;
    raw_to_issue(raw)
        .ok_or_else(|| AppError::Config(format!("{owner}/{repo}#{number} is a pull request, not an issue.")))
}

/// Validate the token (and repo access, if a repo is configured).
pub async fn ping(cfg: &GithubSourceConfig, token: &str) -> AppResult<()> {
    let c = client();
    let resp = c
        .get(format!("{API_BASE}/user"))
        .header("Authorization", auth_header(token))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    let _ = check(resp, "auth probe").await?;
    if let Some(repo) = cfg.repo.as_deref().filter(|r| !r.is_empty()) {
        let resp = c
            .get(format!("{API_BASE}/repos/{}/{}", cfg.owner, repo))
            .header("Authorization", auth_header(token))
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?;
        let _ = check(resp, "repo access probe").await?;
    }
    Ok(())
}

/// Best-effort parse of a GitHub issue URL into (owner, repo, number).
/// Accepts `https://github.com/<owner>/<repo>/issues/<n>` (with optional
/// trailing path/query).
pub fn extract_issue_ref(url: &str) -> Option<(String, String, i64)> {
    let marker = "github.com/";
    let idx = url.find(marker)? + marker.len();
    let rest = &url[idx..];
    let mut parts = rest.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    let kind = parts.next()?; // "issues"
    if owner.is_empty() || repo.is_empty() || kind != "issues" {
        return None;
    }
    let num_str = parts.next()?;
    let num: String = num_str.chars().take_while(|c| c.is_ascii_digit()).collect();
    let number = num.parse::<i64>().ok()?;
    Some((owner.to_string(), repo.to_string(), number))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_issue_url() {
        assert_eq!(
            extract_issue_ref("https://github.com/octocat/hello/issues/42"),
            Some(("octocat".into(), "hello".into(), 42))
        );
        assert_eq!(
            extract_issue_ref("https://github.com/octocat/hello/issues/42#issuecomment-1"),
            Some(("octocat".into(), "hello".into(), 42))
        );
        // PR url -> not an issue.
        assert_eq!(extract_issue_ref("https://github.com/octocat/hello/pull/42"), None);
        assert_eq!(extract_issue_ref("https://example.com"), None);
    }

    #[test]
    fn derives_repo_full_name() {
        assert_eq!(
            repo_full_name("https://api.github.com/repos/octocat/hello"),
            Some("octocat/hello".into())
        );
        assert_eq!(repo_full_name("https://api.github.com/user"), None);
    }

    #[test]
    fn source_ref_format() {
        let issue = GithubIssue {
            number: 7,
            repo_full_name: "octocat/hello".into(),
            title: "t".into(),
            state: "open".into(),
            body: None,
            html_url: "u".into(),
        };
        assert_eq!(issue.source_ref(), "octocat/hello#7");
    }

    #[test]
    fn scope_filter_owner_and_repo() {
        let issue = GithubIssue {
            number: 1,
            repo_full_name: "Octocat/Hello".into(),
            title: "t".into(),
            state: "open".into(),
            body: None,
            html_url: "u".into(),
        };
        // Owner match (case-insensitive), no repo filter.
        assert!(matches_scope(&issue, &GithubSourceConfig { owner: "octocat".into(), repo: None }));
        // Owner + matching repo.
        assert!(matches_scope(
            &issue,
            &GithubSourceConfig { owner: "octocat".into(), repo: Some("hello".into()) }
        ));
        // Wrong repo.
        assert!(!matches_scope(
            &issue,
            &GithubSourceConfig { owner: "octocat".into(), repo: Some("other".into()) }
        ));
        // Wrong owner.
        assert!(!matches_scope(&issue, &GithubSourceConfig { owner: "someoneelse".into(), repo: None }));
    }
}
