//! Minimal GitHub REST client.
//! Only what Conveyer needs: list issues assigned to the authenticated user
//! and fetch one issue by id, plus a cheap auth/access probe.

pub mod auth;

use crate::error::{AppError, AppResult};
use crate::models::GithubSourceConfig;
use serde::Deserialize;
use serde_json::Value;

/// Hard cap on Search API pages (100/page) so a noisy account can't spin
/// forever. 5 pages = up to 500 assigned issues, far more than realistic.
const MAX_PAGES: u32 = 5;

/// Normalise a configured host to a bare hostname (no scheme / trailing slash).
/// Empty / unset means public GitHub.
fn normalize_host(host: Option<&str>) -> Option<String> {
    let h = host?.trim().trim_end_matches('/');
    let h = h.strip_prefix("https://").or_else(|| h.strip_prefix("http://")).unwrap_or(h);
    let h = h.trim();
    if h.is_empty() || h.eq_ignore_ascii_case("github.com") || h.eq_ignore_ascii_case("api.github.com") {
        None
    } else {
        Some(h.to_string())
    }
}

/// REST API base URL for a host.
/// - public GitHub:            https://api.github.com
/// - data residency (*.ghe.com): https://api.<sub>.ghe.com
/// - GitHub Enterprise Server: https://<host>/api/v3
fn api_base(host: Option<&str>) -> String {
    match normalize_host(host) {
        None => "https://api.github.com".to_string(),
        Some(h) if h.to_ascii_lowercase().ends_with(".ghe.com") => format!("https://api.{h}"),
        Some(h) => format!("https://{h}/api/v3"),
    }
}

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

/// Bare repo name from the config, tolerating an `owner/name` entry (we just
/// take the last path segment) and trimming whitespace. None when unset/blank.
fn configured_repo(cfg: &GithubSourceConfig) -> Option<String> {
    let r = cfg.repo.as_deref()?.trim();
    let name = r.rsplit('/').next().unwrap_or(r).trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Keep only issues whose repo owner matches `cfg.owner` (case-insensitive),
/// and—if set—whose repo matches `cfg.repo`. Filtering client-side sidesteps
/// the GitHub `user:` vs `org:` search-qualifier ambiguity.
fn matches_scope(issue: &GithubIssue, cfg: &GithubSourceConfig) -> bool {
    let mut parts = issue.repo_full_name.split('/');
    let owner = parts.next().unwrap_or("");
    let repo = parts.next().unwrap_or("");
    if !owner.eq_ignore_ascii_case(cfg.owner.trim()) {
        return false;
    }
    match configured_repo(cfg) {
        Some(r) => repo.eq_ignore_ascii_case(&r),
        None => true,
    }
}

/// Issues assigned to the authenticated user, scoped to the source's owner
/// (and repo, if set). Open issues only.
pub async fn fetch_assigned_issues(
    cfg: &GithubSourceConfig,
    token: &str,
) -> AppResult<Vec<GithubIssue>> {
    let base = api_base(cfg.host.as_deref());
    let c = client();
    let mut out = Vec::new();
    for page in 1..=MAX_PAGES {
        let url = format!(
            "{base}/search/issues?q=assignee:@me+is:issue+is:open&per_page=100&page={page}"
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
/// `host` is the bare GitHub host; None = github.com.
pub async fn fetch_issue(
    token: &str,
    host: Option<&str>,
    owner: &str,
    repo: &str,
    number: i64,
) -> AppResult<GithubIssue> {
    let url = format!("{}/repos/{owner}/{repo}/issues/{number}", api_base(host));
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
    let base = api_base(cfg.host.as_deref());
    let c = client();
    let resp = c
        .get(format!("{base}/user"))
        .header("Authorization", auth_header(token))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    let _ = check(resp, "auth probe").await?;
    if let Some(repo) = configured_repo(cfg) {
        let resp = c
            .get(format!("{base}/repos/{}/{}", cfg.owner.trim(), repo))
            .header("Authorization", auth_header(token))
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?;
        let _ = check(resp, "repo access probe").await?;
    }
    Ok(())
}

/// Best-effort parse of a GitHub issue URL into (owner, repo, number).
/// Host-agnostic: accepts public github.com and Enterprise hosts, e.g.
/// `https://github.acme.com/<owner>/<repo>/issues/<n>` (with optional
/// trailing path/query).
pub fn extract_issue_ref(url: &str) -> Option<(String, String, i64)> {
    // Strip scheme, then split the path. Expect <host>/<owner>/<repo>/issues/<n>.
    let no_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let mut parts = no_scheme.split('/');
    let _host = parts.next()?;
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
        assert!(matches_scope(&issue, &GithubSourceConfig { owner: "octocat".into(), repo: None, host: None }));
        // Owner + matching repo.
        assert!(matches_scope(
            &issue,
            &GithubSourceConfig { owner: "octocat".into(), repo: Some("hello".into()), host: None }
        ));
        // Wrong repo.
        assert!(!matches_scope(
            &issue,
            &GithubSourceConfig { owner: "octocat".into(), repo: Some("other".into()), host: None }
        ));
        // Wrong owner.
        assert!(!matches_scope(&issue, &GithubSourceConfig { owner: "someoneelse".into(), repo: None, host: None }));
    }

    #[test]
    fn scope_filter_tolerates_owner_prefixed_repo() {
        let issue = GithubIssue {
            number: 1,
            repo_full_name: "octocat/hello".into(),
            title: "t".into(),
            state: "open".into(),
            body: None,
            html_url: "u".into(),
        };
        // User typed "owner/name" in the Repo field — we take the last segment.
        assert!(matches_scope(
            &issue,
            &GithubSourceConfig { owner: "octocat".into(), repo: Some("octocat/hello".into()), host: None }
        ));
        // Blank-ish repo (just whitespace) behaves like no filter.
        assert!(matches_scope(
            &issue,
            &GithubSourceConfig { owner: "octocat".into(), repo: Some("  ".into()), host: None }
        ));
    }

    #[test]
    fn api_base_for_hosts() {
        // Public GitHub (None / blank / github.com all normalise to public).
        assert_eq!(api_base(None), "https://api.github.com");
        assert_eq!(api_base(Some("")), "https://api.github.com");
        assert_eq!(api_base(Some("github.com")), "https://api.github.com");
        assert_eq!(api_base(Some("https://github.com/")), "https://api.github.com");
        // Data residency.
        assert_eq!(api_base(Some("acme.ghe.com")), "https://api.acme.ghe.com");
        // Self-hosted GitHub Enterprise Server.
        assert_eq!(api_base(Some("github.acme.com")), "https://github.acme.com/api/v3");
        assert_eq!(api_base(Some("https://github.acme.com")), "https://github.acme.com/api/v3");
    }

    #[test]
    fn extract_issue_ref_enterprise_host() {
        assert_eq!(
            extract_issue_ref("https://github.acme.com/team/app/issues/9"),
            Some(("team".into(), "app".into(), 9))
        );
    }
}
