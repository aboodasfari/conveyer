//! Session runner: spawns the Node sidecar for a phase, parses NDJSON
//! events from its stdout, persists them, and forwards live events to
//! the UI.
//!
//! Lifecycle wiring:
//! - When a phase enters `running` (via runs_start, phase_approve, or the
//!   auto-advance in phase_complete), spawn a session for it.
//! - On `{"type":"done","ok":true}` the runner calls into
//!   commands::runs::phase_complete to advance the pipeline.
//! - On `{"type":"done","ok":false}` we mark the phase failed and the run
//!   failed.
//! - On unclean exit we do the same.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

/// Tracks the active session per phase so callers can cancel.
pub struct RunnerRegistry {
    inner: Mutex<HashMap<String, RunnerHandle>>,
    chats: Mutex<HashMap<String, ChatHandle>>,
}

struct RunnerHandle {
    session_id: String,
    cancel: Option<oneshot::Sender<()>>,
    /// Set when the agent invokes the `send_back_to_implementation` tool
    /// during the review phase. On clean phase completion the runner reads
    /// this to decide whether to advance or rewind.
    review_send_back: Option<String>,
}

/// A warm chat REPL sidecar bound to a phase. Replies are written to
/// `stdin_tx` which the writer task forwards to the child's stdin. When
/// the sidecar exits (idle timeout, EOF, or kill), the entry is dropped
/// by the reader task's cleanup.
struct ChatHandle {
    /// Our Conveyer sessions row id — all turns from this REPL belong
    /// to this single row.
    session_id: String,
    stdin_tx: mpsc::Sender<String>,
}

impl RunnerRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            chats: Mutex::new(HashMap::new()),
        }
    }

    fn register(&self, phase_id: String, session_id: String, cancel: oneshot::Sender<()>) {
        self.inner.lock().unwrap().insert(
            phase_id,
            RunnerHandle {
                session_id,
                cancel: Some(cancel),
                review_send_back: None,
            },
        );
    }

    fn unregister(&self, phase_id: &str) -> Option<String> {
        self.inner.lock().unwrap().remove(phase_id).map(|h| h.session_id)
    }

    /// Try to cancel a phase's session. Returns the session id if there was one.
    pub fn cancel(&self, phase_id: &str) -> Option<String> {
        let mut map = self.inner.lock().unwrap();
        let h = map.get_mut(phase_id)?;
        if let Some(tx) = h.cancel.take() {
            let _ = tx.send(());
        }
        Some(h.session_id.clone())
    }

    pub fn active_session(&self, phase_id: &str) -> Option<String> {
        self.inner.lock().unwrap().get(phase_id).map(|h| h.session_id.clone())
    }

    /// Record that the reviewer requested the work be sent back to the
    /// implementation phase. Returns the previously-recorded reason if any.
    pub fn record_send_back(&self, phase_id: &str, reason: String) {
        let mut map = self.inner.lock().unwrap();
        if let Some(h) = map.get_mut(phase_id) {
            h.review_send_back = Some(reason);
        }
    }

    /// Read the send-back intent for a phase, if the reviewer set one.
    pub fn take_send_back(&self, phase_id: &str) -> Option<String> {
        self.inner.lock().unwrap().get_mut(phase_id)
            .and_then(|h| h.review_send_back.take())
    }

    /// Look up the warm chat sidecar for a phase. Cloned so the caller
    /// doesn't hold the lock while awaiting an async send.
    fn get_chat(&self, phase_id: &str) -> Option<(String, mpsc::Sender<String>)> {
        self.chats.lock().unwrap().get(phase_id).map(|h| (h.session_id.clone(), h.stdin_tx.clone()))
    }

    fn register_chat(&self, phase_id: String, session_id: String, stdin_tx: mpsc::Sender<String>) {
        self.chats.lock().unwrap().insert(phase_id, ChatHandle { session_id, stdin_tx });
    }

    fn unregister_chat(&self, phase_id: &str) -> Option<String> {
        self.chats.lock().unwrap().remove(phase_id).map(|h| h.session_id)
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SidecarEvent {
    Message { role: String, content: String },
    ToolCall {
        phase: String,
        #[serde(default)]
        tool_call_id: Option<String>,
        tool: String,
        #[serde(default)]
        arguments: Option<Value>,
        #[serde(default)]
        success: Option<bool>,
        #[serde(default)]
        result: Option<String>,
        #[serde(default)]
        error: Option<String>,
    },
    Artifact { path: String },
    PickWorkspace { path: String },
    SendBack { #[serde(default)] reason: Option<String> },
    /// Emitted by the sidecar once it has a SDK session id, so we can
    /// later call `client.resumeSession(id)` for user chat replies.
    SessionStarted { sdk_session_id: String },
    /// Emitted by the chat REPL sidecar once it has resumed the SDK
    /// session and is listening on stdin for `{type:"reply",...}` cmds.
    Ready,
    /// Emitted by the chat REPL sidecar after each turn finishes.
    TurnDone {
        #[serde(default)]
        ok: bool,
        #[serde(default)]
        error: Option<String>,
    },
    NeedsInput {
        prompt: String,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        choices: Option<Vec<String>>,
    },
    Done {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
    },
}

/// Resolve paths. Sidecar lives at `<app dir>/sidecar/conveyer-agent.mjs`.
/// Artifacts live at `<data dir>/conveyer/artifacts/<task_id>/<run_number>/`.
pub fn sidecar_path() -> Option<PathBuf> {
    // 1. CONVEYER_SIDECAR override (useful for tauri dev cwd).
    if let Ok(p) = std::env::var("CONVEYER_SIDECAR") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    // 2. Walk up from CWD looking for sidecar/conveyer-agent.mjs.
    if let Ok(mut cwd) = std::env::current_dir() {
        for _ in 0..6 {
            let candidate = cwd.join("sidecar/conveyer-agent.mjs");
            if candidate.exists() {
                return Some(candidate);
            }
            if !cwd.pop() {
                break;
            }
        }
    }
    None
}

fn prompts_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CONVEYER_PROMPTS_DIR") {
        return Some(PathBuf::from(p));
    }
    sidecar_path()
        .and_then(|s| s.parent().and_then(|p| p.parent()).map(|p| p.to_path_buf()))
        .map(|root| root.join("prompts"))
}

fn artifacts_root() -> AppResult<PathBuf> {
    if let Ok(p) = std::env::var("CONVEYER_ARTIFACTS_DIR") {
        let pb = PathBuf::from(p);
        std::fs::create_dir_all(&pb)?;
        return Ok(pb);
    }
    let base = dirs::data_dir().ok_or_else(|| {
        crate::error::AppError::Config("no data dir".into())
    })?;
    let p = base.join("conveyer").join("artifacts");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

/// Expand a leading `~` or `~/` to the user's home directory. Returns the
/// input unchanged if it doesn't start with `~`, or the home is unknown.
/// The Copilot SDK (and `git -C`) reject non-absolute paths, so anywhere
/// we hand a user-entered workspace path off to a subprocess we run it
/// through this first.
pub fn expand_path(p: impl Into<String>) -> String {
    let s = p.into();
    if s == "~" {
        return std::env::var("HOME").unwrap_or(s);
    }
    if let Some(rest) = s.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    s
}

/// Newline-separated "name\tpath" lines, for the CONVEYER_WORKSPACES env var.
fn encode_workspaces(ws: &[(String, String)]) -> String {
    ws.iter()
        .map(|(n, p)| format!("{n}\t{p}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Build the absolute artifact path for a (task, run, phase) triple.
/// Layout: `<artifacts_root>/<task_id>/<run_number>/<phase>.md`
/// Run number defaults to 1; in the future when we keep multiple runs per
/// task we'll increment this.
pub fn artifact_path_for(task_id: &str, run_number: u32, phase: &str) -> AppResult<PathBuf> {
    let root = artifacts_root()?;
    let dir = root.join(task_id).join(run_number.to_string());
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{phase}.md")))
}

struct PhaseContext {
    task_id: String,
    task_title: String,
    task_state: String,
    task_description: String,
    parent_title: Option<String>,
    parent_description: Option<String>,
    codebase_path: String,
    /// All configured workspaces (name, path), in display order.
    workspaces: Vec<(String, String)>,
    /// True if the task has an explicit workspace pinned. False means the
    /// prompt should present the workspaces list to the agent.
    explicit_workspace: bool,
    model: String,
    reasoning: Option<String>,
}

async fn load_phase_context(state: &AppState, phase_id: &str) -> AppResult<(PhaseContext, String, String)> {
    // Returns (ctx, run_id, phase_kind).
    let row: (String, String, String, String, String, Option<String>, String, Option<String>) = sqlx::query_as(
        "SELECT t.id, t.title, t.state, COALESCE(t.description,''), t.source_id,
                t.parent_ref, p.kind, t.workspace_path
         FROM phases p
         JOIN runs r  ON r.id = p.run_id
         JOIN tasks t ON t.id = r.task_id
         WHERE p.id = ?",
    )
    .bind(phase_id)
    .fetch_one(&state.db)
    .await?;
    let (task_id, task_title, task_state, task_description, source_id, parent_ref, phase_kind, task_workspace_path) = row;

    // Optional parent story title + description.
    let (parent_title, parent_description) = if let Some(pr) = parent_ref {
        let r: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT title, description FROM tasks WHERE source_id = ? AND source_ref = ?",
        )
        .bind(&source_id)
        .bind(&pr)
        .fetch_optional(&state.db)
        .await?;
        match r {
            Some((t, d)) => (Some(t), d),
            None => (None, None),
        }
    } else {
        (None, None)
    };

    // Workspaces: load the full list (for the prompt) and resolve the
    // codebase path. Precedence:
    //   1. CONVEYER_CODEBASE_PATH env override (debugging)
    //   2. task.workspace_path (explicit pick or freeform path)
    //   3. first workspace in the list
    //   4. legacy settings.codebase_path
    //   5. default ~/code/conveyer-test-repo
    let workspaces: Vec<(String, String)> = sqlx::query_as(
        "SELECT name, path FROM workspaces ORDER BY name COLLATE NOCASE",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let explicit_workspace = task_workspace_path.as_deref().map(|s| !s.is_empty()).unwrap_or(false);

    let codebase_path = expand_path(if let Ok(v) = std::env::var("CONVEYER_CODEBASE_PATH") {
        v
    } else if let Some(wp) = task_workspace_path.clone().filter(|s| !s.is_empty()) {
        wp
    } else if let Some((_, p)) = workspaces.first() {
        p.clone()
    } else {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT value FROM settings WHERE key = 'codebase_path'",
        )
        .fetch_optional(&state.db)
        .await?;
        row.map(|(v,)| v).unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_default();
            format!("{home}/code/conveyer-test-repo")
        })
    });

    // Also expand `~` in the workspaces list we hand to the prompt so the
    // agent gets absolute paths it can actually `cd` into.
    let workspaces: Vec<(String, String)> = workspaces
        .into_iter()
        .map(|(n, p)| (n, expand_path(p)))
        .collect();

    // Model: env override → settings KV per-phase → settings KV default → built-in default.
    let model = resolve_model(&state, &phase_kind).await?;
    // Reasoning effort uses the same precedence as model. Empty means "leave unset".
    let reasoning = resolve_reasoning(&state, &phase_kind).await?;

    let run_id_row: (String,) = sqlx::query_as("SELECT run_id FROM phases WHERE id = ?")
        .bind(phase_id)
        .fetch_one(&state.db)
        .await?;

    Ok((
        PhaseContext {
            task_id,
            task_title,
            task_state,
            task_description,
            parent_title,
            parent_description,
            codebase_path,
            workspaces,
            explicit_workspace,
            model,
            reasoning,
        },
        run_id_row.0,
        phase_kind,
    ))
}

/// Resolve which model the sidecar should use for this phase. Priority:
///   1. CONVEYER_COPILOT_MODEL env var (escape hatch)
///   2. settings KV `model_<phase>` (per-phase override)
///   3. settings KV `model_default`
///   4. fallback "gpt-5.1"
pub async fn resolve_model(state: &AppState, phase_kind: &str) -> AppResult<String> {
    if let Ok(v) = std::env::var("CONVEYER_COPILOT_MODEL") {
        if !v.is_empty() {
            return Ok(v);
        }
    }
    let key_phase = format!("model_{phase_kind}");
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT value FROM settings WHERE key = ?",
    )
    .bind(&key_phase)
    .fetch_optional(&state.db)
    .await?;
    if let Some((v,)) = row {
        if !v.is_empty() {
            return Ok(v);
        }
    }
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT value FROM settings WHERE key = 'model_default'",
    )
    .fetch_optional(&state.db)
    .await?;
    if let Some((v,)) = row {
        if !v.is_empty() {
            return Ok(v);
        }
    }
    Ok("gpt-5.1".to_string())
}

/// Resolve reasoning effort for this phase. Same precedence as model.
/// Returns None when nothing is configured — the sidecar then omits the
/// reasoningEffort field from createSession (models without reasoning
/// support reject it).
async fn resolve_reasoning(state: &AppState, phase_kind: &str) -> AppResult<Option<String>> {
    if let Ok(v) = std::env::var("CONVEYER_COPILOT_REASONING") {
        if !v.is_empty() {
            return Ok(Some(v));
        }
    }
    let key_phase = format!("reasoning_{phase_kind}");
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT value FROM settings WHERE key = ?",
    )
    .bind(&key_phase)
    .fetch_optional(&state.db)
    .await?;
    if let Some((v,)) = row {
        if !v.is_empty() {
            return Ok(Some(v));
        }
    }
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT value FROM settings WHERE key = 'reasoning_default'",
    )
    .fetch_optional(&state.db)
    .await?;
    Ok(row.and_then(|(v,)| if v.is_empty() { None } else { Some(v) }))
}

/// Spawn the sidecar for a phase. Records a `sessions` row, streams
/// stdout into `messages`, persists artifacts, advances the pipeline on
/// successful exit.
pub fn spawn_for_phase(app: AppHandle, phase_id: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_one(&app, &phase_id).await {
            tracing::error!("session runner for phase {phase_id} failed: {e}");
        }
    });
}

/// Spawn a chat-reply sidecar invocation. Resumes the SDK session
/// associated with the given Conveyer session row, feeds it the user's
/// message, streams the agent's response into a fresh `sessions` row
/// attached to the same phase. Does NOT advance the pipeline — the
/// phase status stays where it was (waiting / failed / done).
/// Send a user reply through the warm chat sidecar for `phase_id`,
/// spawning the sidecar if it isn't running yet. Returns once the
/// reply is queued (the agent's response streams in asynchronously
/// via `message_appended` events).
pub async fn chat_send_reply(
    app: AppHandle,
    phase_id: String,
    content: String,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let registry = app.state::<RunnerRegistry>();

    // First try a warm sidecar. If the channel send fails the sidecar
    // died between lookup and write — drop it and fall through to spawn.
    if let Some((session_id, tx)) = registry.get_chat(&phase_id) {
        persist_message(&state, &session_id, "user", &content).await?;
        let _ = app.emit("message_appended", serde_json::json!({
            "session_id": &session_id,
            "role": "user",
            "content": &content,
        }));
        let cmd_line = serde_json::to_string(&serde_json::json!({
            "type": "reply", "content": content,
        })).unwrap_or_default();
        match tx.send(cmd_line).await {
            Ok(_) => {
                emit_run_updated(&app, &state, &phase_id).await;
                return Ok(());
            }
            Err(_) => {
                registry.unregister_chat(&phase_id);
                // fall through to spawn fresh
            }
        }
    }

    spawn_chat_and_send(&app, phase_id, content).await
}

/// Spawn a fresh warm chat sidecar and send it the user's first
/// reply. The sidecar resumes the SDK session, emits `ready` once
/// it's listening on stdin, then runs the reply. Subsequent calls to
/// `chat_send_reply` reuse the same process via the registry.
async fn spawn_chat_and_send(
    app: &AppHandle,
    phase_id: String,
    content: String,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let registry = app.state::<RunnerRegistry>();

    // Look up the SDK session id to resume.
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT sdk_session_id FROM sessions
         WHERE phase_id = ? AND sdk_session_id IS NOT NULL
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(&phase_id)
    .fetch_optional(&state.db)
    .await?;
    let sdk_session_id = match row {
        Some((Some(id),)) => id,
        _ => {
            return Err(AppError::Config(
                "No resumable SDK session on this phase. The original agent run \
                 may have started before chat-reply support; try Send Back or \
                 Restart instead.".into(),
            ));
        }
    };

    let (ctx, run_id, phase_kind) = load_phase_context(&state, &phase_id).await?;

    // Reuse the run's worktree so the agent keeps landing on the same
    // branch. Fall back to the configured codebase if there isn't one.
    let (effective_codebase, branch_name, worktree_path) = {
        let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT worktree_path, branch_name FROM runs WHERE id = ?",
        )
        .bind(&run_id)
        .fetch_optional(&state.db)
        .await?;
        match row {
            Some((Some(wt), Some(br))) if std::path::Path::new(&wt).exists() => {
                (wt.clone(), Some(br), Some(wt))
            }
            _ => (ctx.codebase_path.clone(), None, None),
        }
    };

    let Some(sidecar) = sidecar_path() else {
        return Err(AppError::Other("sidecar/conveyer-agent.mjs not found".into()));
    };
    let Some(prompts) = prompts_dir() else {
        return Err(AppError::Other("prompts dir not found".into()));
    };

    // Create the Conveyer sessions row that this REPL lifetime owns.
    // All turns from this warm sidecar append messages to this row;
    // when the sidecar exits (idle / EOF / kill) the row is marked done.
    let session_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sessions(id, phase_id, role, status, started_at, sdk_session_id)
         VALUES(?, ?, 'chat', 'running', datetime('now'), ?)",
    )
    .bind(&session_id)
    .bind(&phase_id)
    .bind(&sdk_session_id)
    .execute(&state.db)
    .await?;

    // Persist the user message immediately so the UI shows it before
    // the agent has produced anything.
    persist_message(&state, &session_id, "user", &content).await?;
    let _ = app.emit("message_appended", serde_json::json!({
        "session_id": &session_id,
        "role": "user",
        "content": &content,
    }));

    let backend = std::env::var("CONVEYER_BACKEND").unwrap_or_else(|_| "copilot".into());
    let mut cmd = Command::new("node");
    cmd.arg(&sidecar)
        .env("CONVEYER_MODE", "chat_repl")
        .env("CONVEYER_PHASE", &phase_kind)
        .env("CONVEYER_TASK_ID", &ctx.task_id)
        .env("CONVEYER_TASK_TITLE", &ctx.task_title)
        .env("CONVEYER_TASK_STATE", &ctx.task_state)
        .env("CONVEYER_TASK_DESCRIPTION", &ctx.task_description)
        .env("CONVEYER_RUN_ID", &run_id)
        .env("CONVEYER_CODEBASE_PATH", &effective_codebase)
        .env("CONVEYER_PROMPTS_DIR", prompts.display().to_string())
        .env("CONVEYER_COPILOT_MODEL", &ctx.model)
        .env("CONVEYER_BACKEND", &backend)
        .env("CONVEYER_RESUME_SDK_SESSION", &sdk_session_id)
        // Heartbeat-driven idle: the UI pings every 30s while the
        // chat tab is mounted. 75s leaves 2.5 missed pings of slack
        // before shutdown.
        .env("CONVEYER_CHAT_IDLE_MS", "75000");
    if let Some(br) = &branch_name { cmd.env("CONVEYER_BRANCH", br); }
    if let Some(wp) = &worktree_path { cmd.env("CONVEYER_WORKTREE_PATH", wp); }
    if let Some(r) = &ctx.reasoning { cmd.env("CONVEYER_COPILOT_REASONING", r); }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child: Child = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("Failed to spawn chat sidecar: {e}")))?;

    let pid = child.id();
    sqlx::query("UPDATE sessions SET pid = ? WHERE id = ?")
        .bind(pid.map(|p| p as i64))
        .bind(&session_id)
        .execute(&state.db)
        .await?;

    let stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let (stdin_tx, stdin_rx) = mpsc::channel::<String>(8);
    let (ready_tx, ready_rx) = oneshot::channel::<()>();

    // stdin writer task — drains the mpsc into the child's stdin.
    tauri::async_runtime::spawn(chat_stdin_writer(stdin, stdin_rx));

    // stderr drain.
    let app_err = app.clone();
    let sid_err = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let state = app_err.state::<AppState>();
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = persist_message(&state, &sid_err, "system", &line).await;
            let _ = app_err.emit("message_appended", serde_json::json!({
                "session_id": &sid_err,
                "role": "system",
                "content": &line,
            }));
        }
    });

    // stdout reader task — the long-running one. Owns the Child so it
    // can wait on exit + cleanup the registry entry.
    let app_clone = app.clone();
    let sid_clone = session_id.clone();
    let phase_clone = phase_id.clone();
    tauri::async_runtime::spawn(async move {
        chat_reader_loop(app_clone, sid_clone, phase_clone, child, stdout, ready_tx).await;
    });

    // Wait for the sidecar to be ready before we register + send. If it
    // never sends `ready`, the spawn task will clean up on its own.
    let ready_timeout = std::time::Duration::from_secs(60);
    match tokio::time::timeout(ready_timeout, ready_rx).await {
        Ok(Ok(())) => {}
        _ => {
            return Err(AppError::Other(
                "Chat sidecar did not become ready within 60s.".into(),
            ));
        }
    }

    registry.register_chat(phase_id.clone(), session_id.clone(), stdin_tx.clone());

    let cmd_line = serde_json::to_string(&serde_json::json!({
        "type": "reply", "content": content,
    })).unwrap_or_default();
    stdin_tx
        .send(cmd_line)
        .await
        .map_err(|_| AppError::Other("Chat sidecar closed before first reply could be sent.".into()))?;

    emit_run_updated(app, &state, &phase_id).await;
    Ok(())
}

async fn chat_stdin_writer(mut stdin: ChildStdin, mut rx: mpsc::Receiver<String>) {
    while let Some(line) = rx.recv().await {
        if stdin.write_all(line.as_bytes()).await.is_err() { break; }
        if stdin.write_all(b"\n").await.is_err() { break; }
        if stdin.flush().await.is_err() { break; }
    }
}

/// Push a heartbeat ping to the warm chat sidecar, if any. No-op when
/// no sidecar is alive for the phase — callers can fire-and-forget
/// without checking. The sidecar resets its idle timer on each ping
/// so as long as the UI keeps pinging the process stays warm.
pub async fn chat_heartbeat(app: &AppHandle, phase_id: &str) {
    let registry = app.state::<RunnerRegistry>();
    let Some((_sid, tx)) = registry.get_chat(phase_id) else { return };
    let _ = tx.send("{\"type\":\"ping\"}".to_string()).await;
}

/// Long-running reader for a warm chat sidecar. Forwards regular
/// events through `handle_line` and watches for the chat-specific
/// `ready` / `turn_done` events. Owns the Child so it can clean up
/// once the sidecar exits (idle timeout, EOF, or kill).
async fn chat_reader_loop(
    app: AppHandle,
    session_id: String,
    phase_id: String,
    mut child: Child,
    stdout: tokio::process::ChildStdout,
    ready_tx: oneshot::Sender<()>,
) {
    let state = app.state::<AppState>();
    let mut reader = BufReader::new(stdout).lines();
    let mut ready_tx_opt = Some(ready_tx);
    let mut ok = false;
    let mut error_msg: Option<String> = None;

    loop {
        match reader.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() { continue; }
                // Peek for chat-specific events before delegating.
                if let Ok(ev) = serde_json::from_str::<SidecarEvent>(&line) {
                    match &ev {
                        SidecarEvent::Ready => {
                            if let Some(tx) = ready_tx_opt.take() {
                                let _ = tx.send(());
                            }
                            continue;
                        }
                        SidecarEvent::TurnDone { .. } => {
                            emit_run_updated(&app, &state, &phase_id).await;
                            continue;
                        }
                        _ => {}
                    }
                }
                if !handle_line(&app, &state, &session_id, &phase_id, &line, &mut ok, &mut error_msg).await {
                    // `done` event = sidecar is shutting down (idle or
                    // command). Reader continues to drain until EOF.
                    continue;
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }

    let _ = child.wait().await;

    // Mark the session row done and remove from the chat registry.
    let _ = sqlx::query("UPDATE sessions SET status='done', finished_at=datetime('now') WHERE id=?")
        .bind(&session_id)
        .execute(&state.db)
        .await;
    let registry = app.state::<RunnerRegistry>();
    registry.unregister_chat(&phase_id);
    emit_run_updated(&app, &state, &phase_id).await;
}


async fn run_one(app: &AppHandle, phase_id: &str) -> AppResult<()> {
    let state = app.state::<AppState>();

    // Bail out if there's already a live runner for this phase.
    let registry = app.state::<RunnerRegistry>();
    if registry.active_session(phase_id).is_some() {
        return Ok(());
    }

    let (ctx, run_id, phase_kind) = load_phase_context(&state, phase_id).await?;

    // For implementation/review/submit, Conveyer owns a dedicated git worktree
    // on branch `abdulasfari/<slug>`. Created lazily on the first such phase
    // (typically implementation), reused by the rest. The working directory
    // for the SDK session is the worktree so all file ops naturally land on
    // the branch and `git diff base..HEAD` is meaningful.
    //
    // The outcome is captured so we can post a system message into chat
    // *after* the session row is created — that way the user actually sees
    // what happened (created at X / reused / failed because Y) instead of
    // it just landing in tracing logs.
    let mut worktree_note: Option<String> = None;
    let (effective_codebase, branch_name, worktree_path) = if matches!(
        phase_kind.as_str(),
        "implementation" | "review" | "submit"
    ) {
        match crate::worktree::ensure_for_run(
            &state,
            &run_id,
            &ctx.task_title,
            std::path::Path::new(&ctx.codebase_path),
        ).await {
            Ok((wt, br, _base)) => {
                let cwd = wt.to_string_lossy().to_string();
                worktree_note = Some(format!("[worktree] using {cwd} on branch {br}"));
                (cwd, Some(br), Some(wt.to_string_lossy().to_string()))
            }
            Err(e) => {
                tracing::error!("failed to ensure worktree for run {run_id}: {e}");
                worktree_note = Some(format!(
                    "[worktree] FAILED to create worktree in {}: {e}. The agent will run in the original workspace; commits will NOT show up in the Diff tab.",
                    ctx.codebase_path,
                ));
                (ctx.codebase_path.clone(), None, None)
            }
        }
    } else {
        (ctx.codebase_path.clone(), None, None)
    };

    // Locate sidecar + prompts.
    let Some(sidecar) = sidecar_path() else {
        tracing::error!("sidecar/conveyer-agent.mjs not found. set CONVEYER_SIDECAR to its path");
        return Ok(());
    };
    let Some(prompts) = prompts_dir() else {
        tracing::error!("prompts dir not found. set CONVEYER_PROMPTS_DIR to its path");
        return Ok(());
    };

    let artifact_path = artifact_path_for(&ctx.task_id, 1, &phase_kind)?;

    // Create the session row.
    let session_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sessions(id, phase_id, role, status, started_at)
         VALUES(?, ?, 'main', 'running', datetime('now'))",
    )
    .bind(&session_id)
    .bind(phase_id)
    .execute(&state.db)
    .await?;

    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    registry.register(phase_id.to_string(), session_id.clone(), cancel_tx);

    // Surface worktree outcome to chat now that the session exists.
    if let Some(note) = worktree_note.take() {
        let _ = persist_message(&state, &session_id, "system", &note).await;
        let _ = app.emit("message_appended", serde_json::json!({
            "session_id": session_id,
            "role": "system",
            "content": note,
        }));
    }

    // Spawn the sidecar.
    let backend = std::env::var("CONVEYER_BACKEND").unwrap_or_else(|_| "copilot".into());
    let mut cmd = Command::new("node");
    cmd.arg(&sidecar)
        .env("CONVEYER_PHASE", &phase_kind)
        .env("CONVEYER_TASK_ID", &ctx.task_id)
        .env("CONVEYER_TASK_TITLE", &ctx.task_title)
        .env("CONVEYER_TASK_STATE", &ctx.task_state)
        .env("CONVEYER_TASK_DESCRIPTION", &ctx.task_description)
        .env("CONVEYER_RUN_ID", &run_id)
        .env("CONVEYER_CODEBASE_PATH", &effective_codebase)
        .env("CONVEYER_PROMPTS_DIR", prompts.display().to_string())
        .env("CONVEYER_ARTIFACT_PATH", artifact_path.display().to_string())
        .env("CONVEYER_COPILOT_MODEL", &ctx.model)
        .env("CONVEYER_BACKEND", &backend)
        .env("CONVEYER_WORKSPACES", encode_workspaces(&ctx.workspaces))
        .env("CONVEYER_WORKSPACE_EXPLICIT", if ctx.explicit_workspace { "1" } else { "0" });
    if let Some(br) = &branch_name {
        cmd.env("CONVEYER_BRANCH", br);
    }
    if let Some(wp) = &worktree_path {
        cmd.env("CONVEYER_WORKTREE_PATH", wp);
    }
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(p) = &ctx.parent_title {
        cmd.env("CONVEYER_PARENT_TITLE", p);
    }
    if let Some(p) = &ctx.parent_description {
        cmd.env("CONVEYER_PARENT_DESCRIPTION", p);
    }
    if let Some(r) = &ctx.reasoning {
        cmd.env("CONVEYER_COPILOT_REASONING", r);
    }
    // Hand over previous phase artifacts if they exist on disk.
    let context_doc = artifact_path_for(&ctx.task_id, 1, "exploration").ok();
    let plan_doc = artifact_path_for(&ctx.task_id, 1, "planning").ok();
    if let Some(p) = context_doc.filter(|p| p.exists()) {
        cmd.env("CONVEYER_CONTEXT_DOC", p.display().to_string());
    }
    if let Some(p) = plan_doc.filter(|p| p.exists()) {
        cmd.env("CONVEYER_PLAN_DOC", p.display().to_string());
    }

    // Pre-render the prompt to disk so the Prompt tab populates immediately,
    // before the (slow-to-start) Copilot SDK has any chance to boot. We
    // invoke the sidecar in CONVEYER_MODE=render_prompt — same env, just
    // builds the prompt + writes prompt.md + exits.
    {
        let mut pre = Command::new("node");
        pre.arg(&sidecar)
            .env("CONVEYER_MODE", "render_prompt")
            .env("CONVEYER_PHASE", &phase_kind)
            .env("CONVEYER_TASK_ID", &ctx.task_id)
            .env("CONVEYER_TASK_TITLE", &ctx.task_title)
            .env("CONVEYER_TASK_STATE", &ctx.task_state)
            .env("CONVEYER_TASK_DESCRIPTION", &ctx.task_description)
            .env("CONVEYER_CODEBASE_PATH", &effective_codebase)
            .env("CONVEYER_PROMPTS_DIR", prompts.display().to_string())
            .env("CONVEYER_ARTIFACT_PATH", artifact_path.display().to_string())
            .env("CONVEYER_WORKSPACES", encode_workspaces(&ctx.workspaces))
            .env("CONVEYER_WORKSPACE_EXPLICIT", if ctx.explicit_workspace { "1" } else { "0" });
        if let Some(p) = &ctx.parent_title {
            pre.env("CONVEYER_PARENT_TITLE", p);
        }
        if let Some(p) = &ctx.parent_description {
            pre.env("CONVEYER_PARENT_DESCRIPTION", p);
        }
        if let Some(br) = &branch_name {
            pre.env("CONVEYER_BRANCH", br);
        }
        if let Some(wp) = &worktree_path {
            pre.env("CONVEYER_WORKTREE_PATH", wp);
        }
        let context_doc = artifact_path_for(&ctx.task_id, 1, "exploration").ok();
        let plan_doc = artifact_path_for(&ctx.task_id, 1, "planning").ok();
        if let Some(p) = context_doc.filter(|p| p.exists()) {
            pre.env("CONVEYER_CONTEXT_DOC", p.display().to_string());
        }
        if let Some(p) = plan_doc.filter(|p| p.exists()) {
            pre.env("CONVEYER_PLAN_DOC", p.display().to_string());
        }
        // Best-effort; don't fail the phase if the pre-render fails.
        match pre.stdout(Stdio::null()).stderr(Stdio::null()).status().await {
            Ok(s) if !s.success() => {
                tracing::warn!("render_prompt sidecar exited with {s}");
            }
            Err(e) => tracing::warn!("render_prompt sidecar failed to spawn: {e}"),
            _ => {}
        }
    }

    let mut child: Child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Failed to spawn sidecar: {e}");
            persist_message(&state, &session_id, "system", &msg).await?;
            mark_phase_failed(&state, phase_id).await?;
            emit_run_updated(app, &state, phase_id).await;
            registry.unregister(phase_id);
            return Ok(());
        }
    };

    let pid = child.id();
    sqlx::query("UPDATE sessions SET pid = ? WHERE id = ?")
        .bind(pid.map(|p| p as i64))
        .bind(&session_id)
        .execute(&state.db)
        .await?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let mut reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    let app_clone = app.clone();
    let sid_clone = session_id.clone();
    // Drain stderr into the session log as 'system' messages.
    tauri::async_runtime::spawn(async move {
        let state = app_clone.state::<AppState>();
        while let Ok(Some(line)) = stderr_reader.next_line().await {
            let _ = persist_message(&state, &sid_clone, "system", &line).await;
            let _ = app_clone.emit("message_appended", serde_json::json!({
                "session_id": &sid_clone,
                "role": "system",
                "content": &line,
            }));
        }
    });

    let mut ok = false;
    let mut error_msg: Option<String> = None;

    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                let _ = child.kill().await;
                error_msg = Some("Cancelled by user".to_string());
                break;
            }
            line = reader.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        if !handle_line(app, &state, &session_id, phase_id, &line, &mut ok, &mut error_msg).await {
                            // 'done' event seen — stop reading.
                            break;
                        }
                    }
                    Ok(None) => break, // EOF
                    Err(e) => {
                        error_msg = Some(format!("Read error: {e}"));
                        break;
                    }
                }
            }
        }
    }

    let status = child.wait().await;
    let exit_ok = matches!(status, Ok(s) if s.success());
    let final_ok = ok && exit_ok;

    sqlx::query(
        "UPDATE sessions SET status = ?, finished_at = datetime('now') WHERE id = ?",
    )
    .bind(if final_ok { "done" } else { "failed" })
    .bind(&session_id)
    .execute(&state.db)
    .await?;

    // Read send-back intent BEFORE we unregister so the runner handle's
    // state is still live.
    let send_back_reason = registry.take_send_back(phase_id);
    registry.unregister(phase_id);

    if final_ok {
        if let Some(reason) = send_back_reason {
            // Reviewer asked to send back to implementation. Route via the
            // review_rewind gate instead of the normal advance path.
            let _ = crate::commands::runs::review_send_back_internal(
                app, &state, phase_id, &reason,
            ).await;
        } else {
            // Normal advance. phase_complete is awaitable when called
            // directly with state instead of via tauri::command.
            let _ = crate::commands::runs::complete_phase_internal(app, &state, phase_id).await;
        }
    } else {
        let final_msg = error_msg.unwrap_or_else(|| "Session ended without success".to_string());
        let _ = persist_message(&state, &session_id, "system", &format!("[error] {final_msg}")).await;
        mark_phase_failed(&state, phase_id).await?;
        emit_run_updated(app, &state, phase_id).await;
    }

    Ok(())
}

async fn handle_line(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    phase_id: &str,
    line: &str,
    ok: &mut bool,
    error_msg: &mut Option<String>,
) -> bool {
    if line.trim().is_empty() {
        return true;
    }
    let parsed: Result<SidecarEvent, _> = serde_json::from_str(line);
    let event = match parsed {
        Ok(e) => e,
        Err(_) => {
            // Treat non-JSON lines as system messages so we don't lose them.
            let _ = persist_message(state, session_id, "system", line).await;
            let _ = app.emit("message_appended", serde_json::json!({
                "session_id": session_id,
                "role": "system",
                "content": line,
            }));
            return true;
        }
    };

    match event {
        SidecarEvent::Message { role, content } => {
            let _ = persist_message(state, session_id, &role, &content).await;
            let _ = app.emit("message_appended", serde_json::json!({
                "session_id": session_id,
                "role": role,
                "content": content,
            }));
        }
        SidecarEvent::ToolCall { phase, tool_call_id, tool, arguments, success, result, error } => {
            // Persist the tool call as a structured message. Frontend
            // pairs starts/completes by tool_call_id when rendering.
            let role = if phase == "start" { "tool_call_start" } else { "tool_call_complete" };
            let payload = serde_json::json!({
                "tool_call_id": tool_call_id,
                "tool": tool,
                "arguments": arguments,
                "success": success,
                "result": result,
                "error": error,
            });
            let content = payload.to_string();
            let _ = persist_message(state, session_id, role, &content).await;
            let _ = app.emit("message_appended", serde_json::json!({
                "session_id": session_id,
                "role": role,
                "content": content,
            }));
        }
        SidecarEvent::Artifact { path } => {
            let _ = sqlx::query("UPDATE phases SET artifact_path = ? WHERE id = ?")
                .bind(&path)
                .bind(phase_id)
                .execute(&state.db)
                .await;
            // Mirror the run_updated event so the right pane refreshes.
            emit_run_updated(app, state, phase_id).await;
        }
        SidecarEvent::PickWorkspace { path } => {
            // Persist the agent-chosen workspace onto the task, so the
            // header chip updates and all subsequent phases use this path.
            let expanded = expand_path(path);
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT r.task_id FROM phases p JOIN runs r ON r.id = p.run_id WHERE p.id = ?",
            )
            .bind(phase_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
            if let Some((task_id,)) = row {
                let _ = sqlx::query("UPDATE tasks SET workspace_path = ? WHERE id = ?")
                    .bind(&expanded)
                    .bind(&task_id)
                    .execute(&state.db)
                    .await;
                let _ = persist_message(
                    state,
                    session_id,
                    "system",
                    &format!("[workspace] pinned to {expanded}"),
                ).await;
                let _ = app.emit("message_appended", serde_json::json!({
                    "session_id": session_id,
                    "role": "system",
                    "content": format!("[workspace] pinned to {expanded}"),
                }));
                emit_run_updated(app, state, phase_id).await;
            }
        }
        SidecarEvent::SendBack { reason } => {
            // Reviewer requested the work be sent back to implementation.
            // Stash the intent so the runner's exit path can decide
            // whether to auto-rewind (gate on) or wait for the user.
            let registry = app.state::<RunnerRegistry>();
            let reason_text = reason.unwrap_or_default();
            registry.record_send_back(phase_id, reason_text.clone());
            let display = if reason_text.is_empty() {
                "[review] requested send-back to implementation".to_string()
            } else {
                format!("[review] requested send-back: {reason_text}")
            };
            let _ = persist_message(state, session_id, "system", &display).await;
            let _ = app.emit("message_appended", serde_json::json!({
                "session_id": session_id,
                "role": "system",
                "content": display,
            }));
        }
        SidecarEvent::SessionStarted { sdk_session_id } => {
            // First time the SDK hands us a session id; pin it onto our
            // sessions row so chat_reply can call resumeSession later.
            let _ = sqlx::query(
                "UPDATE sessions SET sdk_session_id = ? WHERE id = ?",
            )
            .bind(&sdk_session_id)
            .bind(session_id)
            .execute(&state.db)
            .await;
        }
        SidecarEvent::NeedsInput { prompt, kind, choices } => {
            let payload = serde_json::json!({
                "prompt": prompt,
                "kind": kind,
                "choices": choices,
            });
            let _ = sqlx::query(
                "INSERT INTO notifications(id, task_id, session_id, kind, payload_json)
                 SELECT ?, t.id, ?, 'needs_input', ?
                 FROM phases p
                 JOIN runs r ON r.id = p.run_id
                 JOIN tasks t ON t.id = r.task_id
                 WHERE p.id = ?",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(session_id)
            .bind(payload.to_string())
            .bind(phase_id)
            .execute(&state.db)
            .await;
        }
        SidecarEvent::Ready | SidecarEvent::TurnDone { .. } => {
            // Chat-REPL-only events; the chat reader loop intercepts
            // them before delegating here. If they reach this dispatcher
            // (e.g. emitted in the wrong mode) just ignore.
        }
        SidecarEvent::Done { ok: done_ok, error } => {
            *ok = done_ok;
            if !done_ok {
                *error_msg = error;
            }
            return false;
        }
    }

    let _ = (Value::Null,); // suppress unused import lint if any
    true
}

async fn persist_message(
    state: &AppState,
    session_id: &str,
    role: &str,
    content: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO messages(session_id, role, content) VALUES(?, ?, ?)",
    )
    .bind(session_id)
    .bind(role)
    .bind(content)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn mark_phase_failed(state: &AppState, phase_id: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE phases SET status='failed', finished_at=datetime('now') WHERE id=?",
    )
    .bind(phase_id)
    .execute(&state.db)
    .await?;
    // Run goes failed too.
    let row: Option<(String,)> = sqlx::query_as("SELECT run_id FROM phases WHERE id = ?")
        .bind(phase_id)
        .fetch_optional(&state.db)
        .await?;
    if let Some((run_id,)) = row {
        sqlx::query(
            "UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?",
        )
        .bind(&run_id)
        .execute(&state.db)
        .await?;
    }
    Ok(())
}

/// On app startup, reconcile any rows that were left marked as `running` by a
/// previous app session. The sidecar subprocesses are children of the Tauri
/// process (`kill_on_drop(true)`), so they cannot survive a Conveyer restart.
/// Anything still marked `running` is stale and must be marked failed so the
/// UI doesn't lie about progress.
pub async fn reconcile_orphaned_runs(state: &AppState) -> AppResult<()> {
    let now_note = "[interrupted] Conveyer was closed while this phase was running.";

    // Append a marker message to any orphaned sessions so the user sees in
    // the chat why it stopped.
    let orphans: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM sessions WHERE status = 'running'",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    for (session_id,) in &orphans {
        let _ = sqlx::query(
            "INSERT INTO messages(session_id, role, content) VALUES(?, 'system', ?)",
        )
        .bind(session_id)
        .bind(now_note)
        .execute(&state.db)
        .await;
    }

    sqlx::query(
        "UPDATE sessions SET status='failed', finished_at=datetime('now') WHERE status='running'",
    )
    .execute(&state.db)
    .await?;
    sqlx::query(
        "UPDATE phases SET status='failed', finished_at=datetime('now') WHERE status='running'",
    )
    .execute(&state.db)
    .await?;
    sqlx::query(
        "UPDATE runs SET status='failed', finished_at=datetime('now') WHERE status='running'",
    )
    .execute(&state.db)
    .await?;

    if !orphans.is_empty() {
        tracing::info!("reconciled {} orphaned running session(s)", orphans.len());
    }
    Ok(())
}

async fn emit_run_updated(app: &AppHandle, state: &AppState, phase_id: &str) {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT r.id, t.id FROM phases p
         JOIN runs r ON r.id = p.run_id
         JOIN tasks t ON t.id = r.task_id
         WHERE p.id = ?",
    )
    .bind(phase_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    if let Some((run_id, task_id)) = row {
        let _ = app.emit(
            "run_updated",
            serde_json::json!({ "task_id": task_id, "run_id": run_id }),
        );
    }
}
