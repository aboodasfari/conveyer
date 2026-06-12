//! Minimal Azure DevOps REST client.
//! Only what Conveyer needs: list assigned-to-me work items and fetch one by id.

pub mod auth;

use crate::error::{AppError, AppResult};
use crate::models::AdoSourceConfig;
use serde::Deserialize;
use serde_json::{json, Value};

const API_VERSION: &str = "7.1";

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("conveyer/0.1")
        .build()
        .expect("reqwest client build")
}

/// Read the response body when status is an error, and surface a useful
/// excerpt — ADO often returns a JSON `message` or an HTML sign-in page.
async fn check(resp: reqwest::Response, ctx: &str) -> AppResult<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let snippet = excerpt(&body);
    Err(AppError::Other(format!("{ctx}: HTTP {status} — {snippet}")))
}

fn excerpt(body: &str) -> String {
    // Try JSON message field first.
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = v.get("message").and_then(|x| x.as_str()) {
            return msg.to_string();
        }
    }
    // Common ADO sign-in-page heuristic.
    if body.contains("Sign In") || body.contains("AADSTS") {
        return "ADO returned a sign-in page; the token is likely for the wrong tenant. Try `az login --tenant <tenant-with-ADO>` or `az account set -s <subscription>`.".into();
    }
    let trimmed = body.trim();
    if trimmed.len() > 240 {
        format!("{}…", &trimmed[..240])
    } else {
        trimmed.to_string()
    }
}

#[derive(Debug, Clone)]
pub struct WorkItem {
    pub id: i64,
    pub title: String,
    pub state: String,
    pub description: Option<String>,
    pub parent_id: Option<i64>,
    pub fields: Value,
}

#[derive(Debug, Deserialize)]
struct WiqlResult {
    #[serde(rename = "workItems")]
    work_items: Vec<WiqlItem>,
}

#[derive(Debug, Deserialize)]
struct WiqlItem {
    id: i64,
}

#[derive(Debug, Deserialize)]
struct WorkItemsBatch {
    value: Vec<RawWorkItem>,
}

#[derive(Debug, Deserialize)]
struct RawWorkItem {
    id: i64,
    fields: Value,
    #[serde(default)]
    relations: Vec<RawRelation>,
}

#[derive(Debug, Deserialize)]
struct RawRelation {
    rel: String,
    url: String,
}

fn parent_id_from_relations(relations: &[RawRelation]) -> Option<i64> {
    for r in relations {
        if r.rel == "System.LinkTypes.Hierarchy-Reverse" {
            // url ends with /_apis/wit/workItems/<id>
            if let Some(idx) = r.url.rfind('/') {
                if let Ok(n) = r.url[idx + 1..].parse::<i64>() {
                    return Some(n);
                }
            }
        }
    }
    None
}

fn raw_to_work_item(raw: RawWorkItem) -> WorkItem {
    let title = raw
        .fields
        .get("System.Title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let state = raw
        .fields
        .get("System.State")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let description = raw
        .fields
        .get("System.Description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let parent_id = parent_id_from_relations(&raw.relations);
    WorkItem {
        id: raw.id,
        title,
        state,
        description,
        parent_id,
        fields: raw.fields,
    }
}

/// Run a WIQL query to find work items currently assigned to the caller.
pub async fn fetch_assigned_work_items(
    cfg: &AdoSourceConfig,
    auth_header: &str,
) -> AppResult<Vec<WorkItem>> {
    let wiql = "SELECT [System.Id] FROM WorkItems \
                WHERE [System.AssignedTo] = @me \
                AND [System.State] NOT IN ('Closed','Removed','Done','Resolved') \
                ORDER BY [System.ChangedDate] DESC";
    let url = format!(
        "https://dev.azure.com/{}/{}/_apis/wit/wiql?api-version={}",
        cfg.org, cfg.project, API_VERSION
    );
    let resp = client()
        .post(&url)
        .header("Authorization", auth_header)
        .json(&json!({ "query": wiql }))
        .send()
        .await?;
    let resp = check(resp, "WIQL query").await?;
    let q: WiqlResult = resp.json().await?;
    if q.work_items.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<String> = q.work_items.iter().map(|w| w.id.to_string()).collect();
    fetch_work_items_batch(cfg, auth_header, &ids).await
}

/// Fetch full work items by id (in chunks of 200 to respect ADO limits).
/// Uses `$expand=relations` so we can extract Hierarchy-Reverse parents,
/// and explicitly requests System.Description for the detail view.
pub async fn fetch_work_items_batch(
    cfg: &AdoSourceConfig,
    auth_header: &str,
    ids: &[String],
) -> AppResult<Vec<WorkItem>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let mut out = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(200) {
        let url = format!(
            "https://dev.azure.com/{}/{}/_apis/wit/workitems?ids={}&$expand=relations&api-version={}",
            cfg.org,
            cfg.project,
            chunk.join(","),
            API_VERSION
        );
        let resp = client()
            .get(&url)
            .header("Authorization", auth_header)
            .send()
            .await?;
        let resp = check(resp, "fetch work items batch").await?;
        let batch: WorkItemsBatch = resp.json().await?;
        out.extend(batch.value.into_iter().map(raw_to_work_item));
    }
    Ok(out)
}

pub async fn fetch_work_item(
    cfg: &AdoSourceConfig,
    auth_header: &str,
    id: i64,
) -> AppResult<WorkItem> {
    let url = format!(
        "https://dev.azure.com/{}/{}/_apis/wit/workitems/{}?$expand=relations&api-version={}",
        cfg.org, cfg.project, id, API_VERSION
    );
    let resp = client()
        .get(&url)
        .header("Authorization", auth_header)
        .send()
        .await?;
    let resp = check(resp, &format!("fetch work item {id}")).await?;
    let raw: RawWorkItem = resp.json().await?;
    Ok(raw_to_work_item(raw))
}

/// Cheap probe: list one project to validate auth + org/project access.
/// Returns Ok(()) on success, propagates a body-rich error otherwise.
pub async fn ping(cfg: &AdoSourceConfig, auth_header: &str) -> AppResult<()> {
    let url = format!(
        "https://dev.azure.com/{}/_apis/projects?$top=1&api-version={}",
        cfg.org, API_VERSION
    );
    let resp = client()
        .get(&url)
        .header("Authorization", auth_header)
        .send()
        .await?;
    let _ = check(resp, "auth probe").await?;
    Ok(())
}

/// Best-effort extraction of a work item id from common ADO URL shapes.
pub fn extract_work_item_id(url: &str) -> Option<i64> {
    for sep in ["/edit/", "workitem=", "workItemId="] {
        if let Some(idx) = url.find(sep) {
            let tail = &url[idx + sep.len()..];
            let num: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(n) = num.parse::<i64>() {
                return Some(n);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_work_item_id() {
        assert_eq!(
            extract_work_item_id("https://dev.azure.com/o/p/_workitems/edit/12345"),
            Some(12345)
        );
        assert_eq!(
            extract_work_item_id("https://dev.azure.com/o/p/_queries?workitem=42"),
            Some(42)
        );
        assert_eq!(extract_work_item_id("https://example.com"), None);
    }
}
