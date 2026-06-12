use crate::ado;
use crate::ado::auth::{header_value, AuthInputs, AuthKind};
use crate::error::{AppError, AppResult};
use crate::models::{AdoSourceConfig, Source, Task};
use crate::state::AppState;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

const SOURCE_COLS: &str =
    "id, kind, name, config_json, pat_env, enabled, created_at, auth_kind, az_account";

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

async fn load_ado_source(state: &AppState, source_id: &str) -> AppResult<(Source, AdoSourceConfig, String)> {
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

#[tauri::command]
pub async fn tasks_list(state: State<'_, AppState>) -> AppResult<Vec<TaskSummary>> {
    let tasks = sqlx::query_as::<_, Task>(
        "SELECT id, source_id, source_ref, title, state, url, source_meta_json,
                discovered_at, updated_at
         FROM tasks ORDER BY updated_at DESC",
    )
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

/// Trigger an immediate refresh for a single source. Returns count of new/updated tasks.
#[tauri::command]
pub async fn tasks_refresh(state: State<'_, AppState>, source_id: String) -> AppResult<usize> {
    let (src, cfg, auth) = load_ado_source(&state, &source_id).await?;
    let items = ado::fetch_assigned_work_items(&cfg, &auth).await?;
    let mut changed = 0usize;
    for it in items {
        let url = format!(
            "https://dev.azure.com/{}/{}/_workitems/edit/{}",
            cfg.org, cfg.project, it.id
        );
        let id = Uuid::new_v4().to_string();
        let res = sqlx::query(
            "INSERT INTO tasks(id, source_id, source_ref, title, state, url, source_meta_json, updated_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(source_id, source_ref) DO UPDATE SET
                title = excluded.title,
                state = excluded.state,
                url   = excluded.url,
                source_meta_json = excluded.source_meta_json,
                updated_at = datetime('now')",
        )
        .bind(&id)
        .bind(&src.id)
        .bind(it.id.to_string())
        .bind(&it.title)
        .bind(&it.state)
        .bind(&url)
        .bind(serde_json::to_string(&it.fields)?)
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
    sqlx::query(
        "INSERT INTO tasks(id, source_id, source_ref, title, state, url, source_meta_json, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(source_id, source_ref) DO UPDATE SET
            title = excluded.title,
            state = excluded.state,
            url   = excluded.url,
            source_meta_json = excluded.source_meta_json,
            updated_at = datetime('now')",
    )
    .bind(&row_id)
    .bind(&src.id)
    .bind(item.id.to_string())
    .bind(&item.title)
    .bind(&item.state)
    .bind(&url)
    .bind(serde_json::to_string(&item.fields)?)
    .execute(&state.db)
    .await?;

    let task = sqlx::query_as::<_, Task>(
        "SELECT id, source_id, source_ref, title, state, url, source_meta_json,
                discovered_at, updated_at
         FROM tasks WHERE source_id=? AND source_ref=?",
    )
    .bind(&src.id)
    .bind(item.id.to_string())
    .fetch_one(&state.db)
    .await?;
    Ok(task)
}
