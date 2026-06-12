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

#[derive(Debug, Clone)]
pub struct WorkItem {
    pub id: i64,
    pub title: String,
    pub state: String,
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
        .await?
        .error_for_status()?;
    let q: WiqlResult = resp.json().await?;
    if q.work_items.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<String> = q.work_items.iter().map(|w| w.id.to_string()).collect();
    fetch_work_items_batch(cfg, auth_header, &ids).await
}

async fn fetch_work_items_batch(
    cfg: &AdoSourceConfig,
    auth_header: &str,
    ids: &[String],
) -> AppResult<Vec<WorkItem>> {
    let url = format!(
        "https://dev.azure.com/{}/{}/_apis/wit/workitems?ids={}&fields=System.Id,System.Title,System.State,System.WorkItemType,System.AssignedTo,System.Tags&api-version={}",
        cfg.org,
        cfg.project,
        ids.join(","),
        API_VERSION
    );
    let resp = client()
        .get(&url)
        .header("Authorization", auth_header)
        .send()
        .await?
        .error_for_status()?;
    let batch: WorkItemsBatch = resp.json().await?;
    Ok(batch
        .value
        .into_iter()
        .map(|raw| {
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
            WorkItem { id: raw.id, title, state, fields: raw.fields }
        })
        .collect())
}

pub async fn fetch_work_item(
    cfg: &AdoSourceConfig,
    auth_header: &str,
    id: i64,
) -> AppResult<WorkItem> {
    let url = format!(
        "https://dev.azure.com/{}/{}/_apis/wit/workitems/{}?api-version={}",
        cfg.org, cfg.project, id, API_VERSION
    );
    let resp = client()
        .get(&url)
        .header("Authorization", auth_header)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "ADO returned {} for work item {id}",
            resp.status()
        )));
    }
    let raw: RawWorkItem = resp.json().await?;
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
    Ok(WorkItem { id: raw.id, title, state, fields: raw.fields })
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
