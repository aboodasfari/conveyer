use crate::ado;
use crate::ado::auth::{header_value, AuthInputs, AuthKind};
use crate::ado::WorkItem;
use crate::error::{AppError, AppResult};
use crate::models::{AdoSourceConfig, Source, Task};
use crate::state::AppState;
use serde::Serialize;
use std::collections::HashSet;
use tauri::State;
use uuid::Uuid;

const SOURCE_COLS: &str =
    "id, kind, name, config_json, pat_env, enabled, created_at, auth_kind, az_account";
const TASK_COLS: &str =
    "id, source_id, source_ref, title, state, url, source_meta_json,
     discovered_at, updated_at, parent_ref, is_self_assigned, description";

#[derive(Debug, Serialize)]
pub struct TaskSummary {
    #[serde(flatten)]
    pub task: Task,
    pub run_status: Option<String>,
}

async fn source_auth_header(src: &Source) -> AppResult<String> {
    header_value(AuthInputs {
        kind: AuthKind::parse(&src.auth_kind),
        pat_env: &src.pat_env,
        az_account: &src.az_account,
    })
    .await
}

async fn load_ado_source(
    state: &AppState,
    source_id: &str,
) -> AppResult<(Source, AdoSourceConfig, String)> {
    let src = sqlx::query_as::<_, Source>(&format!(
        "SELECT {SOURCE_COLS} FROM sources WHERE id=?"
    ))
    .bind(source_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("source {source_id}")))?;

    if src.kind != "ado" {
        return Err(AppError::Config(format!("unsupported source kind {}", src.kind)));
    }
    let cfg: AdoSourceConfig = serde_json::from_str(&src.config_json)?;
    let auth = source_auth_header(&src).await?;
    Ok((src, cfg, auth))
}

fn work_item_url(cfg: &AdoSourceConfig, id: i64) -> String {
    format!(
        "https://dev.azure.com/{}/{}/_workitems/edit/{}",
        cfg.org, cfg.project, id
    )
}

#[tauri::command]
pub async fn tasks_list(state: State<'_, AppState>) -> AppResult<Vec<TaskSummary>> {
    let tasks = sqlx::query_as::<_, Task>(&format!(
        "SELECT {TASK_COLS} FROM tasks ORDER BY updated_at DESC"
    ))
    .fetch_all(&state.db)
    .await?;

    let mut out = Vec::with_capacity(tasks.len());
    for t in tasks {
        let status: Option<(String,)> = sqlx::query_as(
            "SELECT status FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1",
        )
        .bind(&t.id)
        .fetch_optional(&state.db)
        .await?;
        out.push(TaskSummary { task: t, run_status: status.map(|r| r.0) });
    }
    Ok(out)
}

/// Refresh known + assigned work items for a source.
///
/// 1. WIQL discovers items currently @me.
/// 2. We also re-fetch every task already in the DB for this source so
///    state changes (incl. items that have since been closed / re-assigned)
///    surface in the UI.
/// 3. We fetch any parent work items referenced by the above set, so the
///    dashboard can render a story → task hierarchy even when the parent
///    isn't assigned to the user.
///
/// Returns count of rows touched (inserted or updated).
#[tauri::command]
pub async fn tasks_refresh(state: State<'_, AppState>, source_id: String) -> AppResult<usize> {
    let (src, cfg, auth) = load_ado_source(&state, &source_id).await?;

    // 1. WIQL → currently-assigned ids
    let assigned = ado::fetch_assigned_work_items(&cfg, &auth).await?;
    let mut assigned_ids: HashSet<i64> = assigned.iter().map(|w| w.id).collect();

    // 2. Existing tasks in DB for this source — keep them fresh too.
    let known_refs: Vec<(String,)> = sqlx::query_as(
        "SELECT source_ref FROM tasks WHERE source_id = ?",
    )
    .bind(&src.id)
    .fetch_all(&state.db)
    .await?;
    let mut all_ids: HashSet<i64> = assigned_ids.iter().copied().collect();
    for (r,) in &known_refs {
        if let Ok(n) = r.parse::<i64>() {
            all_ids.insert(n);
        }
    }

    // 3. Fetch the union with expanded relations so we get parent links.
    let mut items: Vec<WorkItem> = if all_ids.is_empty() {
        vec![]
    } else {
        let ids: Vec<String> = all_ids.iter().map(|n| n.to_string()).collect();
        ado::fetch_work_items_batch(&cfg, &auth, &ids).await?
    };

    // 4. Find parents referenced by anything we just pulled, fetch the ones
    //    we don't already have.
    let have: HashSet<i64> = items.iter().map(|w| w.id).collect();
    let missing_parents: Vec<i64> = items
        .iter()
        .filter_map(|w| w.parent_id)
        .filter(|p| !have.contains(p))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if !missing_parents.is_empty() {
        let ids: Vec<String> = missing_parents.iter().map(|n| n.to_string()).collect();
        let parents = ado::fetch_work_items_batch(&cfg, &auth, &ids).await?;
        items.extend(parents);
    }

    // 5. Upsert everything. Parents pulled only for context are marked
    //    is_self_assigned = 0 (unless they happen to also be in assigned_ids).
    let mut changed = 0usize;
    for it in &items {
        let url = work_item_url(&cfg, it.id);
        let parent_ref = it.parent_id.map(|p| p.to_string());
        let self_assigned = if assigned_ids.remove(&it.id) || assigned_ids.contains(&it.id) {
            1
        } else {
            0
        };
        let id = Uuid::new_v4().to_string();
        let res = sqlx::query(
            "INSERT INTO tasks(id, source_id, source_ref, title, state, url,
                               source_meta_json, parent_ref, is_self_assigned,
                               description, updated_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(source_id, source_ref) DO UPDATE SET
                title            = excluded.title,
                state            = excluded.state,
                url              = excluded.url,
                source_meta_json = excluded.source_meta_json,
                parent_ref       = excluded.parent_ref,
                is_self_assigned = CASE
                    WHEN excluded.is_self_assigned = 1 THEN 1
                    ELSE tasks.is_self_assigned
                END,
                description      = excluded.description,
                updated_at       = datetime('now')",
        )
        .bind(&id)
        .bind(&src.id)
        .bind(it.id.to_string())
        .bind(&it.title)
        .bind(&it.state)
        .bind(&url)
        .bind(serde_json::to_string(&it.fields)?)
        .bind(parent_ref)
        .bind(self_assigned)
        .bind(&it.description)
        .execute(&state.db)
        .await?;
        if res.rows_affected() > 0 {
            changed += 1;
        }
    }
    Ok(changed)
}

/// Manually add a task by URL (e.g. for ADO links the user wants to track).
#[tauri::command]
pub async fn tasks_add_by_url(
    state: State<'_, AppState>,
    source_id: String,
    url: String,
) -> AppResult<Task> {
    let (src, cfg, auth) = load_ado_source(&state, &source_id).await?;
    let id_num = ado::extract_work_item_id(&url)
        .ok_or_else(|| AppError::Config("could not parse work item id from URL".into()))?;
    let item = ado::fetch_work_item(&cfg, &auth, id_num).await?;
    let row_id = Uuid::new_v4().to_string();
    let parent_ref = item.parent_id.map(|p| p.to_string());
    let work_url = work_item_url(&cfg, item.id);
    sqlx::query(
        "INSERT INTO tasks(id, source_id, source_ref, title, state, url,
                           source_meta_json, parent_ref, is_self_assigned,
                           description, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))
         ON CONFLICT(source_id, source_ref) DO UPDATE SET
            title            = excluded.title,
            state            = excluded.state,
            url              = excluded.url,
            source_meta_json = excluded.source_meta_json,
            parent_ref       = excluded.parent_ref,
            description      = excluded.description,
            updated_at       = datetime('now')",
    )
    .bind(&row_id)
    .bind(&src.id)
    .bind(item.id.to_string())
    .bind(&item.title)
    .bind(&item.state)
    .bind(&work_url)
    .bind(serde_json::to_string(&item.fields)?)
    .bind(parent_ref)
    .bind(&item.description)
    .execute(&state.db)
    .await?;

    let task = sqlx::query_as::<_, Task>(&format!(
        "SELECT {TASK_COLS} FROM tasks WHERE source_id=? AND source_ref=?"
    ))
    .bind(&src.id)
    .bind(item.id.to_string())
    .fetch_one(&state.db)
    .await?;
    Ok(task)
}
