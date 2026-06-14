use crate::ado;
use crate::ado::auth::{header_value, AuthInputs, AuthKind};
use crate::ado::{is_skip_type, is_story_type, WorkItem};
use crate::error::{AppError, AppResult};
use crate::models::{AdoSourceConfig, Source, Task};
use crate::state::AppState;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tauri::State;
use uuid::Uuid;

const SOURCE_COLS: &str =
    "id, kind, name, config_json, pat_env, enabled, created_at, auth_kind, az_account";
const TASK_COLS: &str =
    "id, source_id, source_ref, title, state, url, source_meta_json,
     discovered_at, updated_at, parent_ref, is_self_assigned, description, bucket, workspace_path";

#[derive(Debug, Serialize)]
pub struct TaskSummary {
    #[serde(flatten)]
    pub task: Task,
    pub run_status: Option<String>,
    /// Kind of the currently-running or awaiting-approval phase, when there
    /// is an active run. Used by the dashboard to surface what's happening
    /// in flight instead of a generic "running" pill.
    pub current_phase: Option<String>,
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
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT r.id, r.status FROM runs r
             WHERE r.task_id = ? ORDER BY r.started_at DESC LIMIT 1",
        )
        .bind(&t.id)
        .fetch_optional(&state.db)
        .await?;
        let (run_status, current_phase) = if let Some((run_id, status)) = row {
            // For active runs, surface the currently-running/awaiting phase.
            let phase: Option<(String,)> = sqlx::query_as(
                "SELECT kind FROM phases
                 WHERE run_id = ? AND status IN ('running','waiting')
                 ORDER BY ord LIMIT 1",
            )
            .bind(&run_id)
            .fetch_optional(&state.db)
            .await?;
            (Some(status), phase.map(|(k,)| k))
        } else {
            (None, None)
        };
        out.push(TaskSummary { task: t, run_status, current_phase });
    }
    Ok(out)
}

/// Refresh known + assigned work items for a source.
///
/// Pipeline:
/// 1. WIQL discovers items currently @me.
/// 2. We also re-fetch every task already in the DB for this source so
///    state changes (incl. items that have since been closed / re-assigned)
///    surface in the UI.
/// 3. For each fetched item, walk one parent-hop. Only `User Story` / `Bug` /
///    `Issue` / `Product Backlog Item` parents are kept — Features and Epics
///    are intentionally hidden so the dashboard groups by story, not by
///    feature.
///
/// Returns count of rows touched.
#[tauri::command]
pub async fn tasks_refresh(state: State<'_, AppState>, source_id: String) -> AppResult<usize> {
    // Short-circuit for non-ADO sources (e.g. the demo source seeded from
    // tasks_seed_demo): they don't pull from anywhere remote.
    let kind: Option<(String,)> = sqlx::query_as("SELECT kind FROM sources WHERE id = ?")
        .bind(&source_id)
        .fetch_optional(&state.db)
        .await?;
    if let Some((k,)) = &kind {
        if k != "ado" {
            return Ok(0);
        }
    }

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

    // 3. First-pass fetch (with relations so we can see parent ids).
    let mut items: Vec<WorkItem> = if all_ids.is_empty() {
        vec![]
    } else {
        let ids: Vec<String> = all_ids.iter().map(|n| n.to_string()).collect();
        ado::fetch_work_items_batch(&cfg, &auth, &ids).await?
    };

    // 4. Fetch missing parents (one hop). After this we'll decide which
    //    of them to keep based on type.
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
        // Only keep story-type parents. Features/Epics are dropped on the floor.
        items.extend(parents.into_iter().filter(|p| is_story_type(&p.work_item_type)));
    }

    // 5. Index everything by id so we can resolve parent types.
    let by_id: HashMap<i64, WorkItem> =
        items.iter().cloned().map(|w| (w.id, w)).collect();

    // 6. Upsert. Skip Feature/Epic/Theme/Initiative items entirely; if any
    //    were stored from an earlier version, evict them now.
    let mut changed = 0usize;
    for it in &items {
        if is_skip_type(&it.work_item_type) {
            sqlx::query("DELETE FROM tasks WHERE source_id = ? AND source_ref = ?")
                .bind(&src.id)
                .bind(it.id.to_string())
                .execute(&state.db)
                .await?;
            continue;
        }
        let url = work_item_url(&cfg, it.id);
        // Stories have no parent_ref shown (they ARE the root in our view).
        let parent_ref = if is_story_type(&it.work_item_type) {
            None
        } else {
            it.parent_id
                .and_then(|pid| by_id.get(&pid))
                .filter(|p| is_story_type(&p.work_item_type))
                .map(|p| p.id.to_string())
        };
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
        .ok_or_else(|| AppError::Config("Could not parse work item ID from URL.".into()))?;
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

/// Seed demo data: a local source + a story with two child tasks
/// pointing at the conveyer-test-repo, so the user can shake out the
/// run pipeline without needing a real ADO source.
#[tauri::command]
pub async fn tasks_seed_demo(state: State<'_, AppState>) -> AppResult<()> {
    // 1. Default the codebase to the test repo if the user hasn't picked one.
    let existing_cb: Option<(String,)> = sqlx::query_as(
        "SELECT value FROM settings WHERE key = 'codebase_path'",
    )
    .fetch_optional(&state.db)
    .await?;
    if existing_cb.is_none() {
        if let Ok(home) = std::env::var("HOME") {
            let test_repo = format!("{home}/code/conveyer-test-repo");
            sqlx::query(
                "INSERT OR REPLACE INTO settings(key, value) VALUES('codebase_path', ?)",
            )
            .bind(&test_repo)
            .execute(&state.db)
            .await?;
        }
    }

    // 2. Wipe the previous demo run from the DB. FK ON DELETE CASCADE takes
    //    care of tasks -> runs -> phases -> sessions -> messages, so
    //    deleting the source is enough. Cancel any live runner first to
    //    avoid orphan child processes writing into a deleted phase.
    let existing_source: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM sources WHERE kind = 'demo' LIMIT 1",
    )
    .fetch_optional(&state.db)
    .await?;
    let demo_task_ids: Vec<String> = if let Some((src_id,)) = &existing_source {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT id FROM tasks WHERE source_id = ?",
        )
        .bind(src_id)
        .fetch_all(&state.db)
        .await?;
        rows.into_iter().map(|(id,)| id).collect()
    } else {
        vec![]
    };
    if let Some((src_id,)) = existing_source {
        sqlx::query("DELETE FROM sources WHERE id = ?")
            .bind(&src_id)
            .execute(&state.db)
            .await?;
    }

    // 3. Wipe artifact directories for those tasks. Best-effort.
    for tid in &demo_task_ids {
        if let Ok(root) = artifacts_root_for_task(tid) {
            let _ = tokio::fs::remove_dir_all(root).await;
        }
    }

    // 4. Reset the test repo's working tree to its initial state, if the
    //    user is pointing at our seeded copy. Best-effort.
    if let Ok(home) = std::env::var("HOME") {
        let test_repo = format!("{home}/code/conveyer-test-repo");
        let _ = tokio::process::Command::new("git")
            .arg("-C")
            .arg(&test_repo)
            .arg("reset")
            .arg("--hard")
            .arg("HEAD")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
        let _ = tokio::process::Command::new("git")
            .arg("-C")
            .arg(&test_repo)
            .arg("clean")
            .arg("-fd")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
    }

    // 5. Create a fresh demo source.
    let source_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sources(id, kind, name, config_json, pat_env, enabled,
                             auth_kind, az_account)
         VALUES(?, 'demo', 'Demo (test repo)', '{}', '', 1, 'pat', '')",
    )
    .bind(&source_id)
    .execute(&state.db)
    .await?;

    // 6. Story + two child tasks. Stable source_refs so identifiers in
    //    artifacts/<task_id>/ stay readable when grepping.
    let story_ref = "demo-story-1";
    let child_a_ref = "demo-task-1";
    let child_b_ref = "demo-task-2";

    let story_desc = "Polish the toy code in `conveyer-test-repo`. \
                      Two child tasks track the work.";
    let task_a_desc = "`src/math.ts:add` rounds its inputs and so loses precision \
                      when called with floats. Fix it to handle floats correctly \
                      and add a test.";
    let task_b_desc = "`src/greet.ts:greet` should optionally accept a title \
                      (e.g. \"Dr.\") and prefix it to the name. Update the call site \
                      in `src/index.ts` to demo the new behaviour.";

    upsert_demo_task(&state, &source_id, story_ref, None, "Demo story: tidy the test repo", "Active", story_desc).await?;
    upsert_demo_task(&state, &source_id, child_a_ref, Some(story_ref), "Fix add() float handling", "Active", task_a_desc).await?;
    upsert_demo_task(&state, &source_id, child_b_ref, Some(story_ref), "Add optional title to greet()", "Active", task_b_desc).await?;

    Ok(())
}

/// Resolve `<artifacts_root>/<task_id>` for cleanup. Returns Err if no
/// data dir is configured.
fn artifacts_root_for_task(task_id: &str) -> AppResult<std::path::PathBuf> {
    if let Ok(p) = std::env::var("CONVEYER_ARTIFACTS_DIR") {
        return Ok(std::path::PathBuf::from(p).join(task_id));
    }
    let base = dirs::data_dir()
        .ok_or_else(|| AppError::Config("no data dir".into()))?;
    Ok(base.join("conveyer").join("artifacts").join(task_id))
}

/// Create a free-form task that isn't tied to any external tracker.
/// Lives under the singleton `local` source. Returns the created task id.
#[tauri::command]
pub async fn tasks_create_local(
    state: State<'_, AppState>,
    title: String,
    description: Option<String>,
    workspace_path: Option<String>,
) -> AppResult<String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Config("Title is required.".into()));
    }
    let desc = description.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let wp = workspace_path.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    // Allocate a stable, monotonically-increasing source_ref so the task
    // shows up in lists in a friendly order.
    let next_n: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(CAST(source_ref AS INTEGER)), 0) + 1
         FROM tasks WHERE source_id = 'local'",
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(1);
    let source_ref = next_n.to_string();
    let id = Uuid::new_v4().to_string();

    sqlx::query(
        "INSERT INTO tasks(id, source_id, source_ref, title, state, url,
                           source_meta_json, parent_ref, is_self_assigned,
                           description, updated_at, workspace_path)
         VALUES(?, 'local', ?, ?, 'Active', '', '{}', NULL, 1, ?, datetime('now'), ?)",
    )
    .bind(&id)
    .bind(&source_ref)
    .bind(&title)
    .bind(&desc)
    .bind(&wp)
    .execute(&state.db)
    .await?;
    Ok(id)
}

/// Delete a task and everything FK-cascaded from it (runs/phases/sessions/
/// messages). Best-effort wipes the on-disk artifact directory too.
/// Refuses to delete tasks under a non-local source — those re-appear on
/// next refresh, so the user almost certainly meant Archive instead.
#[tauri::command]
pub async fn tasks_delete(state: State<'_, AppState>, task_id: String) -> AppResult<()> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT source_id FROM tasks WHERE id = ?",
    )
    .bind(&task_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((source_id,)) = row else {
        return Err(AppError::NotFound(format!("task {task_id}")));
    };
    if source_id != "local" {
        return Err(AppError::Config(
            "Only local tasks can be deleted. Move this task to Archive instead.".into(),
        ));
    }
    sqlx::query("DELETE FROM tasks WHERE id = ?")
        .bind(&task_id)
        .execute(&state.db)
        .await?;
    if let Ok(root) = artifacts_root_for_task(&task_id) {
        let _ = tokio::fs::remove_dir_all(root).await;
    }
    Ok(())
}

async fn upsert_demo_task(
    state: &AppState,
    source_id: &str,
    source_ref: &str,
    parent_ref: Option<&str>,
    title: &str,
    state_str: &str,
    description: &str,
) -> AppResult<()> {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO tasks(id, source_id, source_ref, title, state, url,
                           source_meta_json, parent_ref, is_self_assigned,
                           description, updated_at)
         VALUES(?, ?, ?, ?, ?, '', '{}', ?, 1, ?, datetime('now'))
         ON CONFLICT(source_id, source_ref) DO UPDATE SET
            title       = excluded.title,
            state       = excluded.state,
            parent_ref  = excluded.parent_ref,
            description = excluded.description,
            updated_at  = datetime('now')",
    )
    .bind(&id)
    .bind(source_id)
    .bind(source_ref)
    .bind(title)
    .bind(state_str)
    .bind(parent_ref)
    .bind(description)
    .execute(&state.db)
    .await?;
    Ok(())
}
#[tauri::command]
pub async fn tasks_set_bucket(
    state: State<'_, AppState>,
    task_id: String,
    bucket: String,
) -> AppResult<()> {
    if !["active", "backlog", "archive"].contains(&bucket.as_str()) {
        return Err(AppError::Config(format!("invalid bucket '{bucket}'")));
    }
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT source_id, source_ref, parent_ref FROM tasks WHERE id = ?",
    )
    .bind(&task_id)
    .fetch_optional(&state.db)
    .await?;
    let (source_id, source_ref, _parent_ref) =
        row.ok_or_else(|| AppError::NotFound(format!("task {task_id}")))?;

    let mut tx = state.db.begin().await?;
    // Update the task itself.
    sqlx::query("UPDATE tasks SET bucket = ? WHERE id = ?")
        .bind(&bucket)
        .bind(&task_id)
        .execute(&mut *tx)
        .await?;
    // And cascade to children pointing at this task as their parent.
    sqlx::query(
        "UPDATE tasks SET bucket = ? WHERE source_id = ? AND parent_ref = ?",
    )
    .bind(&bucket)
    .bind(&source_id)
    .bind(&source_ref)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}
