use crate::ado;
use crate::ado::auth::{header_value, AuthInputs, AuthKind};
use crate::ado::{is_skip_type, is_story_type, WorkItem};
use crate::error::{AppError, AppResult};
use crate::github;
use crate::models::{AdoSourceConfig, GithubSourceConfig, Source, Task};
use crate::state::AppState;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tauri::State;
use uuid::Uuid;

const SOURCE_COLS: &str =
    "id, kind, name, config_json, pat_env, enabled, created_at, auth_kind, az_account";
const TASK_COLS: &str =
    "id, source_id, source_ref, title, state, url, source_meta_json,
     discovered_at, updated_at, parent_ref, is_self_assigned, description, bucket, workspace_path,
     use_worktree, base_branch_override, branch_override, enable_submit";

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

async fn load_source(state: &AppState, source_id: &str) -> AppResult<Source> {
    sqlx::query_as::<_, Source>(&format!(
        "SELECT {SOURCE_COLS} FROM sources WHERE id=?"
    ))
    .bind(source_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("source {source_id}")))
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
        "SELECT {TASK_COLS} FROM tasks ORDER BY discovered_at DESC, id DESC"
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
            // Include needs_input so the badge can show the agent is blocked
            // on the user, not merely "running".
            let phase: Option<(String, String)> = sqlx::query_as(
                "SELECT kind, status FROM phases
                 WHERE run_id = ? AND status IN ('running','waiting','needs_input')
                 ORDER BY ord LIMIT 1",
            )
            .bind(&run_id)
            .fetch_optional(&state.db)
            .await?;
            match phase {
                // A phase awaiting the user's answer overrides the run's
                // 'running' status for display purposes.
                Some((kind, pstatus)) if pstatus == "needs_input" => {
                    (Some("needs_input".to_string()), Some(kind))
                }
                Some((kind, _)) => (Some(status), Some(kind)),
                None => (Some(status), None),
            }
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
    // Dispatch on the source kind. Local/demo sources don't pull remotely.
    let kind: Option<(String,)> = sqlx::query_as("SELECT kind FROM sources WHERE id = ?")
        .bind(&source_id)
        .fetch_optional(&state.db)
        .await?;
    match kind.as_ref().map(|(k,)| k.as_str()) {
        Some("ado") => tasks_refresh_ado(&state, &source_id).await,
        Some("github") => tasks_refresh_github(&state, &source_id).await,
        _ => Ok(0),
    }
}

/// Refresh issues assigned to the user from a GitHub source. GitHub issues are
/// flat (no parent hop), so each becomes a top-level, self-assigned task.
async fn tasks_refresh_github(state: &AppState, source_id: &str) -> AppResult<usize> {
    let src = load_source(state, source_id).await?;
    let cfg: GithubSourceConfig = serde_json::from_str(&src.config_json)?;
    let token = github::auth::token(
        github::auth::GithubAuthKind::parse(&src.auth_kind),
        &src.pat_env,
        cfg.host.as_deref(),
    )
    .await?;
    let issues = github::fetch_assigned_issues(&cfg, &token).await?;

    let mut changed = 0usize;
    let mut seen: HashSet<String> = HashSet::new();
    for issue in &issues {
        seen.insert(issue.source_ref());
        let id = Uuid::new_v4().to_string();
        let res = sqlx::query(
            "INSERT INTO tasks(id, source_id, source_ref, title, state, url,
                               source_meta_json, parent_ref, is_self_assigned,
                               description, updated_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, datetime('now'))
             ON CONFLICT(source_id, source_ref) DO UPDATE SET
                title            = excluded.title,
                state            = excluded.state,
                url              = excluded.url,
                source_meta_json = excluded.source_meta_json,
                is_self_assigned = 1,
                description      = excluded.description,
                updated_at       = datetime('now')",
        )
        .bind(&id)
        .bind(&src.id)
        .bind(issue.source_ref())
        .bind(&issue.title)
        .bind(&issue.state)
        .bind(&issue.html_url)
        .bind("{}")
        .bind(&issue.body)
        .execute(&state.db)
        .await?;
        if res.rows_affected() > 0 {
            changed += 1;
        }
    }

    // The assigned-issues search only returns OPEN issues, so an issue that was
    // closed (or unassigned) simply drops out of the result set and would never
    // be reconciled — leaving a stale `open` row in the DB. Re-fetch each known
    // task that wasn't in this pass to pick up its current state (e.g. closed).
    // Skip rows already terminal (closed) so we don't re-poll them every refresh.
    let known: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT source_ref, url, state FROM tasks WHERE source_id = ?",
    )
    .bind(&src.id)
    .fetch_all(&state.db)
    .await?;
    for (source_ref, url, state_str) in known {
        if seen.contains(&source_ref) || state_str.eq_ignore_ascii_case("closed") {
            continue;
        }
        let Some((owner, repo, number)) = github::extract_issue_ref(&url) else {
            continue;
        };
        match github::fetch_issue(&token, cfg.host.as_deref(), &owner, &repo, number).await {
            Ok(issue) => {
                // When an issue transitions to closed, move it to the archive
                // bucket so it drops off the active board. Only happens on this
                // open->closed pass (closed rows are skipped above), so we don't
                // override a user who later un-archives it.
                let closed = issue.state.eq_ignore_ascii_case("closed");
                let res = sqlx::query(
                    "UPDATE tasks SET title = ?, state = ?, url = ?, description = ?,
                                      bucket = CASE WHEN ? = 1 THEN 'archive' ELSE bucket END,
                                      updated_at = datetime('now')
                     WHERE source_id = ? AND source_ref = ?",
                )
                .bind(&issue.title)
                .bind(&issue.state)
                .bind(&issue.html_url)
                .bind(&issue.body)
                .bind(i32::from(closed))
                .bind(&src.id)
                .bind(&source_ref)
                .execute(&state.db)
                .await?;
                if res.rows_affected() > 0 {
                    changed += 1;
                }
            }
            Err(e) => {
                tracing::warn!("failed to refresh github issue {source_ref}: {e}");
            }
        }
    }
    Ok(changed)
}

async fn tasks_refresh_ado(state: &AppState, source_id: &str) -> AppResult<usize> {
    let (src, cfg, auth) = load_ado_source(state, source_id).await?;

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
    let src = load_source(&state, &source_id).await?;
    match src.kind.as_str() {
        "github" => add_github_issue_by_url(&state, &src, &url).await,
        "ado" => add_ado_item_by_url(&state, &src, &url).await,
        other => Err(AppError::Config(format!("unsupported source kind {other}"))),
    }
}

async fn add_github_issue_by_url(state: &AppState, src: &Source, url: &str) -> AppResult<Task> {
    let cfg: GithubSourceConfig = serde_json::from_str(&src.config_json)?;
    let (owner, repo, number) = github::extract_issue_ref(url).ok_or_else(|| {
        AppError::Config("Could not parse a GitHub issue URL (expected .../<owner>/<repo>/issues/<n>).".into())
    })?;
    let token = github::auth::token(
        github::auth::GithubAuthKind::parse(&src.auth_kind),
        &src.pat_env,
        cfg.host.as_deref(),
    )
    .await?;
    let issue = github::fetch_issue(&token, cfg.host.as_deref(), &owner, &repo, number).await?;
    let row_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO tasks(id, source_id, source_ref, title, state, url,
                           source_meta_json, parent_ref, is_self_assigned,
                           description, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, '{}', NULL, 1, ?, datetime('now'))
         ON CONFLICT(source_id, source_ref) DO UPDATE SET
            title            = excluded.title,
            state            = excluded.state,
            url              = excluded.url,
            description      = excluded.description,
            updated_at       = datetime('now')",
    )
    .bind(&row_id)
    .bind(&src.id)
    .bind(issue.source_ref())
    .bind(&issue.title)
    .bind(&issue.state)
    .bind(&issue.html_url)
    .bind(&issue.body)
    .execute(&state.db)
    .await?;
    sqlx::query_as::<_, Task>(&format!(
        "SELECT {TASK_COLS} FROM tasks WHERE source_id=? AND source_ref=?"
    ))
    .bind(&src.id)
    .bind(issue.source_ref())
    .fetch_one(&state.db)
    .await
    .map_err(Into::into)
}

async fn add_ado_item_by_url(state: &AppState, src: &Source, url: &str) -> AppResult<Task> {
    let cfg: AdoSourceConfig = serde_json::from_str(&src.config_json)?;
    let auth = source_auth_header(src).await?;
    let id_num = ado::extract_work_item_id(url)
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
    // Demo data is a development aid only — never seed it in release builds.
    if !cfg!(debug_assertions) {
        return Err(AppError::Config(
            "Demo data is only available in development builds.".into(),
        ));
    }
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

    // 6. Story + child tasks. Stable source_refs so identifiers in
    //    artifacts/<task_id>/ stay readable when grepping.
    let story_ref = "demo-story-1";
    let child_a_ref = "demo-task-1";
    let child_b_ref = "demo-task-2";
    let child_c_ref = "demo-task-3";
    let child_d_ref = "demo-task-4";

    let story_desc = "Polish the toy code in `conveyer-test-repo`. \
                      Three child tasks track the work.";
    let task_a_desc = "`src/math.ts:add` rounds its inputs and so loses precision \
                      when called with floats. Fix it to handle floats correctly \
                      and add a test.";
    let task_b_desc = "`src/greet.ts:greet` should optionally accept a title \
                      (e.g. \"Dr.\") and prefix it to the name. Update the call site \
                      in `src/index.ts` to demo the new behaviour.";
    // Overt request for a buggy implementation. The agent is given two
    // requirements but explicitly asked to first ship a deliberately
    // broken version (loses element identity via a JSON-clone "tidy"),
    // ignoring the existing identity test in chunk.test.ts. The Review
    // phase should catch the regression and send back; on the rewind
    // the implementer fixes it for real.
    let task_c_desc = "`src/chunk.ts:chunk` needs:\n\n\
                      1. Input validation — throw `RangeError` for \
                         `size <= 0` or `NaN`, and `TypeError` if `arr` \
                         is not an array. Add tests for both.\n\n\
                      2. For this demo task ONLY: also rewrite the loop \
                         body to clone each chunk with \
                         `JSON.parse(JSON.stringify(...))` instead of \
                         `arr.slice(...)`. Yes, this regresses element \
                         identity and will break `chunk.test.ts` — \
                         that is intentional. We are testing the \
                         Review phase by shipping this regression and \
                         seeing whether it gets sent back.\n\n\
                      Make all of the above changes in one pass. If \
                      the identity test fails as a result, leave it \
                      failing (do NOT delete or weaken the test).";
    // Designed to exercise the ask_user round-trip: a genuine product
    // fork the codebase can't resolve, so the agent should pause and
    // ask which option to build before implementing. The description
    // does NOT mention ask_user — the agent has to recognise on its own
    // that this is a decision only the operator can make.
    let task_d_desc = "Add a `formatDuration(seconds: number): string` helper to \
                      `src/duration.ts` (new file) and export it from `src/index.ts`. \
                      It turns a number of seconds into a human-readable string.\n\n\
                      There are two equally-valid output styles and which one we want \
                      is a product decision that has NOT been made and cannot be \
                      inferred from the codebase:\n\n\
                      - Compact: `1h 5m`, `45s`, `2h 0m 30s`\n\
                      - Verbose: `1 hour 5 minutes`, `45 seconds`\n\n\
                      Implement exactly one style and add a test covering a couple of \
                      cases. Do not implement both, and do not just pick one \
                      arbitrarily — the choice matters and is the operator's to make.";

    upsert_demo_task(&state, &source_id, story_ref, None, "Demo story: tidy the test repo", "Active", story_desc).await?;
    upsert_demo_task(&state, &source_id, child_a_ref, Some(story_ref), "Fix add() float handling", "Active", task_a_desc).await?;
    upsert_demo_task(&state, &source_id, child_b_ref, Some(story_ref), "Add optional title to greet()", "Active", task_b_desc).await?;
    upsert_demo_task(&state, &source_id, child_c_ref, Some(story_ref), "Add input validation to chunk()", "Active", task_c_desc).await?;
    upsert_demo_task(&state, &source_id, child_d_ref, Some(story_ref), "Add formatDuration() helper", "Active", task_d_desc).await?;

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
/// messages). Best-effort wipes the on-disk artifact directory and removes
/// any worktrees this task's runs created (branches are LEFT INTACT — the
/// user might want to keep the code, push it manually, etc.).
///
/// NOTE: Tasks under an external source (ADO etc.) may reappear on the
/// next source refresh if the upstream still has the work item. The
/// confirm modal on the frontend warns the user about this so they can
/// pick Archive instead when that's what they actually want.
#[tauri::command]
pub async fn tasks_delete(state: State<'_, AppState>, task_id: String) -> AppResult<()> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT source_id FROM tasks WHERE id = ?",
    )
    .bind(&task_id)
    .fetch_optional(&state.db)
    .await?;
    if row.is_none() {
        return Err(AppError::NotFound(format!("task {task_id}")));
    }

    // Collect (worktree_path, originating_workspace) for every run on this
    // task that managed to create a worktree. `git worktree remove` has to
    // be run from inside the originating repo (or with a path the repo
    // knows about), so we resolve the workspace from tasks.workspace_path
    // (the same source ensure_for_run used). If nothing's pinned we still
    // try the path standalone — git is good enough to find the linked dir.
    let worktree_paths: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT r.worktree_path, t.workspace_path
         FROM runs r
         JOIN tasks t ON t.id = r.task_id
         WHERE r.task_id = ? AND r.worktree_path IS NOT NULL",
    )
    .bind(&task_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    sqlx::query("DELETE FROM tasks WHERE id = ?")
        .bind(&task_id)
        .execute(&state.db)
        .await?;

    if let Ok(root) = artifacts_root_for_task(&task_id) {
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    // Worktree cleanup runs after the DB delete so a failure here doesn't
    // leave the task in a half-deleted state. We DELIBERATELY do not run
    // `git branch -D <branch>` — preserving the code on disk is the whole
    // point. `git worktree remove --force` un-links the dir + deletes the
    // checkout but leaves the branch ref alone.
    for (wt, ws) in worktree_paths {
        let wt_path = std::path::PathBuf::from(crate::session_runner::expand_path(&wt));
        if !wt_path.exists() {
            continue;
        }
        let mut cmd = tokio::process::Command::new("git");
        if let Some(ws_path) = ws.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg("-C").arg(crate::session_runner::expand_path(ws_path));
        }
        cmd.args(["worktree", "remove", "--force"]).arg(&wt_path);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        let _ = cmd.status().await;
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

/// Set per-task override fields. Any field passed as `None` clears the
/// override (falls back to the global default at run time). Any field omitted
/// from the JSON (so deserialized as `None` from the option-wrapped `Option`)
/// also clears — we treat the call as a full replacement of the override set.
/// Trim and treat empty strings as `None` to avoid storing whitespace.
#[tauri::command]
pub async fn task_overrides_set(
    state: State<'_, AppState>,
    task_id: String,
    use_worktree: Option<bool>,
    base_branch_override: Option<String>,
    branch_override: Option<String>,
    enable_submit: Option<bool>,
) -> AppResult<()> {
    let clean = |s: Option<String>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let base_branch = clean(base_branch_override);
    let branch = clean(branch_override);
    sqlx::query(
        "UPDATE tasks
            SET use_worktree         = ?,
                base_branch_override = ?,
                branch_override      = ?,
                enable_submit        = ?
          WHERE id = ?",
    )
    .bind(use_worktree.map(i64::from))
    .bind(base_branch)
    .bind(branch)
    .bind(enable_submit.map(i64::from))
    .bind(&task_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Fetch a single task by id. Returns NotFound if no such task exists.
#[tauri::command]
pub async fn task_get(state: State<'_, AppState>, task_id: String) -> AppResult<Task> {
    let sql = format!("SELECT {TASK_COLS} FROM tasks WHERE id = ?");
    sqlx::query_as::<_, Task>(&sql)
        .bind(&task_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("task {task_id}")))
}

/// Mark a local task as done (or reopen it). Only applies to tasks under the
/// 'local' source — external sources own their state and would clobber any
/// change on the next refresh, so the UI only offers this for local tasks
/// and we enforce the same rule here defensively.
///
/// done=true  → state='Done',   bucket='archive'  (mirrors a closed PR)
/// done=false → state='Active', bucket='active'   (back on the board)
#[tauri::command]
pub async fn task_local_set_done(
    state: State<'_, AppState>,
    task_id: String,
    done: bool,
) -> AppResult<()> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT source_id FROM tasks WHERE id = ?",
    )
    .bind(&task_id)
    .fetch_optional(&state.db)
    .await?;
    let source_id = row.ok_or_else(|| AppError::NotFound(format!("task {task_id}")))?.0;
    if source_id != "local" {
        return Err(AppError::Config(
            "Only local tasks can be marked done from the app — external tasks are managed in their source."
                .into(),
        ));
    }
    let (next_state, next_bucket) = if done {
        ("Done", "archive")
    } else {
        ("Active", "active")
    };
    sqlx::query(
        "UPDATE tasks SET state = ?, bucket = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(next_state)
    .bind(next_bucket)
    .bind(&task_id)
    .execute(&state.db)
    .await?;
    Ok(())
}
