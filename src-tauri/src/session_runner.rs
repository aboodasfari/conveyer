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
    /// Phases with a live comment processor (so kicks are idempotent).
    comment_procs: Mutex<std::collections::HashSet<String>>,
    /// Per-phase broadcast that fires once each chat turn completes;
    /// the comment processor subscribes to await its turn.
    turn_chans: Mutex<HashMap<String, tokio::sync::broadcast::Sender<()>>>,
}

struct RunnerHandle {
    session_id: String,
    cancel: Option<oneshot::Sender<()>>,
    /// Set when the agent invokes the `send_back_to_implementation` tool
    /// during the review phase. On clean phase completion the runner reads
    /// this to decide whether to advance or rewind.
    review_send_back: Option<String>,
    /// Writes lines to the sidecar's stdin. Used to deliver answers to
    /// `ask_user` / needs_input requests during the main phase run.
    stdin_tx: Option<mpsc::Sender<String>>,
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
            comment_procs: Mutex::new(std::collections::HashSet::new()),
            turn_chans: Mutex::new(HashMap::new()),
        }
    }

    fn register(&self, phase_id: String, session_id: String, cancel: oneshot::Sender<()>) {
        self.inner.lock().unwrap().insert(
            phase_id,
            RunnerHandle {
                session_id,
                cancel: Some(cancel),
                review_send_back: None,
                stdin_tx: None,
            },
        );
    }

    /// Attach the sidecar stdin sender to an already-registered runner
    /// handle (set after the child is spawned and the writer task is up).
    fn set_runner_stdin(&self, phase_id: &str, tx: mpsc::Sender<String>) {
        if let Some(h) = self.inner.lock().unwrap().get_mut(phase_id) {
            h.stdin_tx = Some(tx);
        }
    }

    /// Get a stdin sender for delivering a needs_input answer. Prefers a
    /// warm chat handle (replies during a chat turn) and falls back to
    /// the main runner handle.
    fn stdin_sender(&self, phase_id: &str) -> Option<mpsc::Sender<String>> {
        if let Some(tx) = self.chats.lock().unwrap().get(phase_id).map(|h| h.stdin_tx.clone()) {
            return Some(tx);
        }
        self.inner.lock().unwrap().get(phase_id).and_then(|h| h.stdin_tx.clone())
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

    /// Try to claim the comment processor for a phase. Returns true if the
    /// caller should run it (it wasn't already running). The processor
    /// drains all queued comments, so a second kick while one is active is
    /// a no-op — the running processor will pick up newly-queued comments.
    fn try_start_comment_proc(&self, phase_id: &str) -> bool {
        self.comment_procs.lock().unwrap().insert(phase_id.to_string())
    }

    fn end_comment_proc(&self, phase_id: &str) {
        self.comment_procs.lock().unwrap().remove(phase_id);
    }

    /// Get-or-create the per-phase turn-done broadcast sender.
    fn turn_sender(&self, phase_id: &str) -> tokio::sync::broadcast::Sender<()> {
        let mut map = self.turn_chans.lock().unwrap();
        map.entry(phase_id.to_string())
            .or_insert_with(|| tokio::sync::broadcast::channel(8).0)
            .clone()
    }

    /// Fire a turn-done signal for a phase (best-effort; no-op if no
    /// subscribers).
    fn notify_turn(&self, phase_id: &str) {
        if let Some(tx) = self.turn_chans.lock().unwrap().get(phase_id) {
            let _ = tx.send(());
        }
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
    /// Submit phase: the agent proposed (drafted) a PR. We store it as a
    /// preview; creation happens later on the user's approval.
    ProposePr {
        #[serde(default)] title: Option<String>,
        #[serde(default)] target_branch: Option<String>,
        #[serde(default)] description: Option<String>,
        #[serde(default)] reviewers: Option<Vec<String>>,
        #[serde(default)] work_items: Option<Vec<String>>,
    },
    /// Submit phase: the agent actually created (or failed to create) the PR.
    PrCreated {
        #[serde(default)] number: Option<i64>,
        #[serde(default)] url: Option<String>,
        status: String,
        #[serde(default)] error: Option<String>,
        #[serde(default)] checks: Option<Value>,
    },
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
        #[serde(default)]
        request_id: Option<String>,
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
        /// Sidecar hint that it's about to transition to chat REPL
        /// instead of exiting. When true + ok=true, Rust hands the
        /// live child off to the chat reader loop. Absent / false
        /// keeps today's behaviour (wait for child exit).
        #[serde(default)]
        keep_alive: Option<bool>,
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
    // 3. Bundled into the packaged app (production). On macOS the resource dir
    //    is <bundle>.app/Contents/Resources/; on Linux/Windows it sits next to
    //    the executable.
    if let Some(res) = bundled_resource_dir() {
        let candidate = res.join("sidecar/conveyer-agent.mjs");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn prompts_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CONVEYER_PROMPTS_DIR") {
        return Some(PathBuf::from(p));
    }
    // Prefer the bundled location in production; in dev fall back to the
    // sibling of the sidecar.
    if let Some(res) = bundled_resource_dir() {
        let candidate = res.join("prompts");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    sidecar_path()
        .and_then(|s| s.parent().and_then(|p| p.parent()).map(|p| p.to_path_buf()))
        .map(|root| root.join("prompts"))
}

/// Locate the directory Tauri unpacks bundled `resources` into at runtime.
/// macOS: `<bundle>.app/Contents/Resources/`. Linux/Windows: alongside the
/// executable. Returns `None` in dev where CWD-based lookup handles it.
fn bundled_resource_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    #[cfg(target_os = "macos")]
    {
        // .app/Contents/MacOS/<exe> -> .app/Contents/Resources/
        if let Some(contents) = exe_dir.parent() {
            let candidate = contents.join("Resources");
            if candidate.join("sidecar").exists() || candidate.join("prompts").exists() {
                return Some(candidate);
            }
        }
    }
    if exe_dir.join("sidecar").exists() || exe_dir.join("prompts").exists() {
        return Some(exe_dir.to_path_buf());
    }
    None
}

/// Best-effort lookup of the user's global npm `node_modules` directory so the
/// sidecar can resolve `@github/copilot-sdk` (and friends) without them being
/// installed in a `node_modules` next to the bundled sidecar. Shells out to
/// `npm root -g` once and caches the result for the process lifetime.
pub fn npm_global_root() -> Option<String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            match std::process::Command::new("npm").args(["root", "-g"]).output() {
                Ok(out) if out.status.success() => {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if s.is_empty() || !std::path::Path::new(&s).exists() {
                        tracing::warn!(
                            "npm root -g returned empty or missing path: {s:?}"
                        );
                        return None;
                    }
                    tracing::info!("resolved npm global root: {s}");
                    Some(s)
                }
                Ok(out) => {
                    tracing::warn!(
                        "npm root -g failed (status {:?}): {}",
                        out.status.code(),
                        String::from_utf8_lossy(&out.stderr).trim()
                    );
                    None
                }
                Err(e) => {
                    tracing::warn!(
                        "could not spawn `npm root -g` (npm not in PATH?): {e}"
                    );
                    None
                }
            }
        })
        .clone()
}

/// Build a `node` command (tokio) with NODE_PATH pre-populated so dynamic
/// imports in the sidecar can resolve globally-installed npm packages (notably
/// `@github/copilot-sdk`). Existing NODE_PATH entries are preserved.
pub fn node_command() -> Command {
    let mut cmd = Command::new("node");
    if let Some(root) = npm_global_root() {
        let combined = match std::env::var("NODE_PATH") {
            Ok(existing) if !existing.is_empty() => {
                #[cfg(windows)]
                let sep = ";";
                #[cfg(not(windows))]
                let sep = ":";
                format!("{existing}{sep}{root}")
            }
            _ => root,
        };
        cmd.env("NODE_PATH", combined);
    }
    cmd
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
    /// Source kind: 'ado', 'github', or 'local'.
    source_kind: String,
    /// Source-native identifier: ADO work item id (e.g. "12345") or GitHub
    /// issue ref (e.g. "owner/repo#42"). Empty for local tasks.
    source_ref: String,
    /// Web URL of the work item / issue.
    task_url: String,
    /// Per-task base-branch override. When set, the agent should target this
    /// branch in the PR instead of re-detecting the remote default.
    base_branch_override: Option<String>,
    /// Per-task working-branch override. When set, the agent is operating on
    /// this existing branch (no new branch was created).
    branch_override: Option<String>,
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
    let row: (String, String, String, String, String, Option<String>, String, Option<String>, String, String, String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT t.id, t.title, t.state, COALESCE(t.description,''), t.source_id,
                t.parent_ref, p.kind, t.workspace_path, t.source_ref, t.url, s.kind,
                t.base_branch_override, t.branch_override
         FROM phases p
         JOIN runs r  ON r.id = p.run_id
         JOIN tasks t ON t.id = r.task_id
         JOIN sources s ON s.id = t.source_id
         WHERE p.id = ?",
    )
    .bind(phase_id)
    .fetch_one(&state.db)
    .await?;
    let (task_id, task_title, task_state, task_description, source_id, parent_ref, phase_kind, task_workspace_path, source_ref, task_url, source_kind, base_branch_override, branch_override) = row;

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
            source_kind,
            source_ref,
            task_url,
            base_branch_override,
            branch_override,
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
        if let Err(e) = run_one(&app, &phase_id, None).await {
            tracing::error!("session runner for phase {phase_id} failed: {e}");
        }
    });
}

/// Resume a phase's SDK session and feed it `answer` as the next
/// message, then continue the main run normally (streams output,
/// advances the pipeline on success). Used to recover a needs_input
/// answer after the original sidecar process died (e.g. app restart):
/// instead of forcing a phase restart, we pick the conversation back up.
pub fn spawn_for_phase_resume(
    app: AppHandle,
    phase_id: String,
    sdk_session_id: String,
    answer: String,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_one(&app, &phase_id, Some((sdk_session_id, answer))).await {
            tracing::error!("resume runner for phase {phase_id} failed: {e}");
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
    // Ensure a warm sidecar exists. ensure_chat_spawned is idempotent
    // and returns (session_id, stdin_tx) for whichever sidecar is now
    // alive for this phase.
    let (session_id, tx) = ensure_chat_spawned(&app, &phase_id).await?;

    let state = app.state::<AppState>();
    persist_message(&state, &session_id, "user", &content).await?;
    let _ = app.emit("message_appended", serde_json::json!({
        "session_id": &session_id,
        "role": "user",
        "content": &content,
    }));

    // Optimistic UI signal: turn just kicked off, draw the pulse.
    let _ = app.emit("chat_turn_state", serde_json::json!({
        "phase_id": &phase_id,
        "busy": true,
    }));

    let cmd_line = serde_json::to_string(&serde_json::json!({
        "type": "reply", "content": content,
    })).unwrap_or_default();
    if tx.send(cmd_line).await.is_err() {
        // Sidecar died between ensure + send; surface as a config error
        // so the UI can show a useful message. Next attempt will spawn
        // fresh because the reader-loop already unregistered.
        return Err(AppError::Other(
            "Chat sidecar closed before the reply could be sent.".into(),
        ));
    }
    emit_run_updated(&app, &state, &phase_id).await;
    Ok(())
}

/// Ensure a warm chat sidecar is registered for `phase_id`. Idempotent:
/// if one is already alive, returns it. Otherwise spawns fresh, waits
/// for the `ready` event, registers, and returns. Used both by the
/// reply path and by the eager "warm on tab open" path so the user
/// doesn't pay the SDK cold-start cost on their first message.
async fn ensure_chat_spawned(
    app: &AppHandle,
    phase_id: &str,
) -> AppResult<(String, mpsc::Sender<String>)> {
    let registry = app.state::<RunnerRegistry>();
    if let Some(handle) = registry.get_chat(phase_id) {
        return Ok(handle);
    }

    let state = app.state::<AppState>();

    // Look up the SDK session id to resume.
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT sdk_session_id FROM sessions
         WHERE phase_id = ? AND sdk_session_id IS NOT NULL
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(phase_id)
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

    let (ctx, run_id, phase_kind) = load_phase_context(&state, phase_id).await?;

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
    // All turns from this warm sidecar append messages to this row.
    let session_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sessions(id, phase_id, role, status, started_at, sdk_session_id)
         VALUES(?, ?, 'chat', 'running', datetime('now'), ?)",
    )
    .bind(&session_id)
    .bind(phase_id)
    .bind(&sdk_session_id)
    .execute(&state.db)
    .await?;

    let backend = std::env::var("CONVEYER_BACKEND").unwrap_or_else(|_| "copilot".into());
    let mut cmd = node_command();
    cmd.arg(&sidecar)
        .env("CONVEYER_MODE", "chat_repl")
        .env("CONVEYER_PHASE", &phase_kind)
        .env("CONVEYER_TASK_ID", &ctx.task_id)
        .env("CONVEYER_TASK_TITLE", &ctx.task_title)
        .env("CONVEYER_TASK_STATE", &ctx.task_state)
        .env("CONVEYER_TASK_DESCRIPTION", &ctx.task_description)
        .env("CONVEYER_SOURCE_KIND", &ctx.source_kind)
        .env("CONVEYER_TASK_REF", &ctx.source_ref)
        .env("CONVEYER_TASK_URL", &ctx.task_url)
        .env("CONVEYER_TARGET_BRANCH", ctx.base_branch_override.clone().unwrap_or_default())
        .env("CONVEYER_WORKING_BRANCH", ctx.branch_override.clone().unwrap_or_default())
        .env("CONVEYER_RUN_ID", &run_id)
        .env("CONVEYER_CODEBASE_PATH", &effective_codebase)
        .env("CONVEYER_PROMPTS_DIR", prompts.display().to_string())
        .env("CONVEYER_COPILOT_MODEL", &ctx.model)
        .env("CONVEYER_BACKEND", &backend)
        .env("CONVEYER_RESUME_SDK_SESSION", &sdk_session_id)
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
    let phase_clone = phase_id.to_string();
    let reader = BufReader::new(stdout).lines();
    tauri::async_runtime::spawn(async move {
        chat_reader_loop(app_clone, sid_clone, phase_clone, child, reader, ready_tx).await;
    });

    // Wait for the sidecar to be ready. If it never sends `ready`, the
    // spawn task will clean up on its own when stdout EOFs.
    let ready_timeout = std::time::Duration::from_secs(60);
    match tokio::time::timeout(ready_timeout, ready_rx).await {
        Ok(Ok(())) => {}
        _ => {
            return Err(AppError::Other(
                "Chat sidecar did not become ready within 60s.".into(),
            ));
        }
    }

    registry.register_chat(phase_id.to_string(), session_id.clone(), stdin_tx.clone());
    Ok((session_id, stdin_tx))
}

/// Eagerly spawn the warm chat sidecar for `phase_id` so the user
/// doesn't pay the SDK cold-start cost on their first message.
/// Idempotent and best-effort: silently no-ops if there's no resumable
/// SDK session yet (e.g. phase hasn't run) or if anything else fails.
pub async fn chat_warm(app: &AppHandle, phase_id: &str) {
    let _ = ensure_chat_spawned(app, phase_id).await;
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

/* -------------------------------------------------------------------------- */
/*                           Review-comment processor                         */
/* -------------------------------------------------------------------------- */

/// A queued review comment, minimal projection for processing.
#[derive(sqlx::FromRow)]
struct QueuedComment {
    id: String,
    file_path: String,
    line_start: Option<i64>,
    line_end: Option<i64>,
    snippet: Option<String>,
    body: String,
    commit_marker: String,
    thread_json: Option<String>,
    agent_reply: Option<String>,
}

/// Kick the per-phase comment processor. Idempotent: if one is already
/// running for the phase it returns immediately (the running processor
/// drains newly-queued comments), so this can be called on every
/// comment_create / comment_reopen without piling up workers.
pub fn kick_comment_processor(app: AppHandle, phase_id: String) {
    tauri::async_runtime::spawn(async move {
        let registry = app.state::<RunnerRegistry>();
        if !registry.try_start_comment_proc(&phase_id) {
            return; // already draining
        }
        if let Err(e) = run_comment_processor(&app, &phase_id).await {
            tracing::error!("comment processor for {phase_id} failed: {e}");
        }
        registry.end_comment_proc(&phase_id);
        // A comment may have been queued in the tiny window between the
        // loop seeing an empty queue and us releasing the claim; re-kick
        // so it isn't stranded.
        let has_more: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM comments WHERE phase_id = ? AND status = 'queued' LIMIT 1",
        )
        .bind(&phase_id)
        .fetch_optional(&app.state::<AppState>().db)
        .await
        .ok()
        .flatten();
        if has_more.is_some() {
            kick_comment_processor(app.clone(), phase_id);
        }
    });
}

async fn run_comment_processor(app: &AppHandle, phase_id: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    let registry = app.state::<RunnerRegistry>();

    loop {
        // Next queued comment (FIFO).
        let next: Option<QueuedComment> = sqlx::query_as(
            "SELECT id, file_path, line_start, line_end, snippet, body, commit_marker, thread_json, agent_reply
             FROM comments WHERE phase_id = ? AND status = 'queued'
             ORDER BY created_at, id LIMIT 1",
        )
        .bind(phase_id)
        .fetch_optional(&state.db)
        .await?;
        let Some(c) = next else { break };

        // Mark working.
        sqlx::query("UPDATE comments SET status='working', updated_at=datetime('now') WHERE id=?")
            .bind(&c.id)
            .execute(&state.db)
            .await?;
        let _ = app.emit("comments_changed", serde_json::json!({ "phase_id": phase_id }));

        // Ensure a warm chat sidecar (resumes the SDK session).
        let (session_id, tx) = match ensure_chat_spawned(app, phase_id).await {
            Ok(v) => v,
            Err(e) => {
                // Couldn't reach the agent; surface on the comment and stop.
                sqlx::query(
                    "UPDATE comments SET status='addressed',
                     agent_reply=?, updated_at=datetime('now') WHERE id=?",
                )
                .bind(format!("Couldn't reach the agent: {e}. Reopen to retry."))
                .bind(&c.id)
                .execute(&state.db)
                .await?;
                let _ = app.emit("comments_changed", serde_json::json!({ "phase_id": phase_id }));
                break;
            }
        };

        // Subscribe to turn-done BEFORE sending so we don't miss it.
        let mut turn_rx = registry.turn_sender(phase_id).subscribe();

        // Snapshot the latest message id so we can scoop up just this
        // turn's assistant output as the reply.
        let snap: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(id), 0) FROM messages WHERE session_id = ?",
        )
        .bind(&session_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

        // Persist a concise user message so the chat transcript reads
        // sensibly alongside the diff comment. Use the latest user entry
        // in the thread (the new follow-up on a reopen).
        let loc = comment_loc(&c.file_path, c.line_start, c.line_end);
        let latest_user = latest_user_message(c.thread_json.as_deref()).unwrap_or_else(|| c.body.clone());
        let user_note = format!("Review comment on {loc}: {}", first_line(&latest_user));
        let _ = persist_message(&state, &session_id, "user", &user_note).await;
        let _ = app.emit("message_appended", serde_json::json!({
            "session_id": session_id, "role": "user", "content": user_note,
        }));

        // Send the framed comment as a chat turn.
        let prompt = frame_comment(&c, &loc, &latest_user);
        let cmd = serde_json::json!({ "type": "reply", "content": prompt }).to_string();
        if tx.send(cmd).await.is_err() {
            sqlx::query(
                "UPDATE comments SET status='addressed',
                 agent_reply='The agent process closed before this could be sent. Reopen to retry.',
                 updated_at=datetime('now') WHERE id=?",
            )
            .bind(&c.id)
            .execute(&state.db)
            .await?;
            let _ = app.emit("comments_changed", serde_json::json!({ "phase_id": phase_id }));
            break;
        }

        // Wait for the turn to finish (cap so a wedged turn can't hang the
        // processor forever).
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(30 * 60),
            turn_rx.recv(),
        )
        .await;

        // Capture this turn's assistant output as the reply.
        let replies: Vec<(String,)> = sqlx::query_as(
            "SELECT content FROM messages
             WHERE session_id = ? AND id > ? AND role = 'assistant'
             ORDER BY id",
        )
        .bind(&session_id)
        .bind(snap)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();
        let reply_text = if replies.is_empty() {
            "Addressed.".to_string()
        } else {
            let joined = replies.into_iter().map(|(c,)| c).collect::<Vec<_>>().join("\n\n");
            let cleaned = sanitize_reply(&joined);
            if cleaned.is_empty() { "Addressed.".to_string() } else { cleaned }
        };

        // Append the agent's reply to the thread so the UI renders it as
        // its own bubble, and keep agent_reply as the latest for rollup.
        let mut thread = crate::commands::comments::thread_or_synthesize(
            c.thread_json.as_deref(),
            &c.body,
            c.agent_reply.as_deref(),
        );
        thread.push(serde_json::json!({ "role": "agent", "content": reply_text }));
        let new_thread = serde_json::to_string(&thread).unwrap_or_default();
        sqlx::query(
            "UPDATE comments SET status='addressed', agent_reply=?, thread_json=?, updated_at=datetime('now')
             WHERE id=?",
        )
        .bind(&reply_text)
        .bind(&new_thread)
        .bind(&c.id)
        .execute(&state.db)
        .await?;
        let _ = app.emit("comments_changed", serde_json::json!({ "phase_id": phase_id }));
        // The agent committed a change; refresh the diff.
        emit_run_updated(app, &state, phase_id).await;
    }

    Ok(())
}

fn comment_loc(file: &str, start: Option<i64>, end: Option<i64>) -> String {
    match (start, end) {
        (Some(a), Some(b)) if a != b => format!("{file}:{a}-{b}"),
        (Some(a), _) => format!("{file}:{a}"),
        _ => file.to_string(),
    }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

fn frame_comment(c: &QueuedComment, loc: &str, latest_user: &str) -> String {
    let snippet = c.snippet.as_deref().unwrap_or("").trim_end();
    let snippet_block = if snippet.is_empty() {
        String::new()
    } else {
        format!("\n\nThe commented lines:\n```\n{snippet}\n```")
    };
    format!(
        "You are addressing a code-review comment left on the diff for this phase.\n\n\
         Location: `{loc}`{snippet_block}\n\n\
         Comment:\n{body}\n\n\
         Instructions:\n\
         - Make the requested change in the worktree.\n\
         - COMMIT it. Put the marker `[conveyer-comment:{marker}]` at the END of the \
         commit message.\n\
         - If a commit already exists with that marker (this is a follow-up on the \
         same thread), AMEND that commit (use fixup + autosquash if it is not HEAD) so \
         the thread stays one logical commit — do NOT add a separate commit.\n\
         - Keep changes scoped to this comment.\n\
         - Then reply with ONE or TWO sentences, in plain language, describing what you \
         changed. Do NOT mention the commit marker, commit SHAs, branch names, or these \
         instructions — those are internal plumbing the user shouldn't see. Just describe \
         the change. No preamble.",
        loc = loc,
        snippet_block = snippet_block,
        body = latest_user,
        marker = c.commit_marker,
    )
}

/// Latest user message from a thread_json array, if any.
fn latest_user_message(thread_json: Option<&str>) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(thread_json?).ok()?;
    let arr = v.as_array()?;
    for entry in arr.iter().rev() {
        if entry.get("role").and_then(|r| r.as_str()) == Some("user") {
            return entry.get("content").and_then(|c| c.as_str()).map(|s| s.to_string());
        }
    }
    None
}

/// Strip internal plumbing (the conveyer-comment marker, commit SHAs we
/// don't want surfaced) from an agent reply before showing it.
fn sanitize_reply(s: &str) -> String {
    // Remove any `[conveyer-comment:...]` token and tidy whitespace.
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("[conveyer-comment:") {
        out.push_str(&rest[..start]);
        if let Some(end_rel) = rest[start..].find(']') {
            rest = &rest[start + end_rel + 1..];
        } else {
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}


/// Begin actually creating the proposed PR: flip status to 'creating'
/// and resume the agent with an instruction to create it. The agent
/// reports back via the `pr_created` tool, handled in handle_line.
pub async fn pr_begin_create(
    app: &AppHandle,
    state: &AppState,
    phase_id: &str,
) -> AppResult<()> {
    // Load the draft so we can frame a precise instruction.
    let row: Option<(String, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT title, target_branch, source_branch, description
         FROM pull_requests WHERE phase_id = ?",
    )
    .bind(phase_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((title, target, source, _desc)) = row else {
        return Err(AppError::Config("No drafted pull request to create.".into()));
    };

    sqlx::query("UPDATE pull_requests SET status='creating', error=NULL, updated_at=datetime('now') WHERE phase_id=?")
        .bind(phase_id)
        .execute(&state.db)
        .await?;
    let _ = app.emit("pr_changed", serde_json::json!({ "phase_id": phase_id }));
    emit_run_updated(app, state, phase_id).await;

    // Scrub internal comment markers from the branch's commit messages before
    // the agent pushes, so they never reach the remote. Best-effort: a failure
    // here shouldn't block PR creation (the markers are harmless noise, not a
    // correctness issue), but we log it.
    let wt: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT r.worktree_path, r.base_sha
         FROM phases p JOIN runs r ON r.id = p.run_id WHERE p.id = ?",
    )
    .bind(phase_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some((Some(worktree), Some(base_sha))) = wt {
        if let Err(e) =
            crate::worktree::strip_comment_markers(std::path::Path::new(&worktree), &base_sha)
        {
            tracing::warn!("strip_comment_markers failed for phase {phase_id}: {e}");
        }
    }

    let target = target.unwrap_or_else(|| "the default branch".into());
    let source = source.unwrap_or_default();
    let instruction = format!(
        "The user approved the pull request proposal. Create it now:\n\n\
         1. Push the branch `{source}` to the remote if it isn't already pushed.\n\
         2. Create a DRAFT pull request from `{source}` into `{target}` titled \
            \"{title}\", using the description you proposed (and the repo's PR template \
            if one exists).\n\
         3. Best-effort: queue the required policy/build checks WITHOUT waiting for them \
            to finish. If you can't queue them, that's fine — just note it.\n\
         4. When done, call the `pr_created` tool with the PR number, URL, status \
            ('created' or 'failed'), and the checks you queued. Do not describe internal \
            git/az commands in your reply — just confirm the PR.",
    );
    // Reuse the warm chat sidecar (resumes the SDK session).
    chat_send_reply(app.clone(), phase_id.to_string(), instruction).await
}

/// Deliver a user's answer to a pending `ask_user` / needs_input request.
/// Writes `{type:"answer", request_id, content}` to the live sidecar's
/// stdin so the blocked tool handler resolves and the agent continues.
/// Persists the answer into the transcript, clears the pending state,
/// and flips the phase back to 'running'.
pub async fn submit_input(
    app: &AppHandle,
    phase_id: &str,
    content: &str,
) -> AppResult<()> {
    let state = app.state::<AppState>();

    // Read + validate the pending request on this phase.
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT status, pending_input FROM phases WHERE id = ?",
    )
    .bind(phase_id)
    .fetch_optional(&state.db)
    .await?;
    let (status, pending) = match row {
        Some((s, p)) => (s, p),
        None => return Err(AppError::Config("Phase not found.".into())),
    };
    if status != "needs_input" {
        return Err(AppError::Config(
            "This phase is not waiting for input.".into(),
        ));
    }
    let Some(pending_json) = pending else {
        return Err(AppError::Config("No pending question to answer.".into()));
    };
    let parsed: serde_json::Value = serde_json::from_str(&pending_json)
        .map_err(|e| AppError::Other(format!("corrupt pending_input: {e}")))?;
    let request_id = parsed.get("request_id").and_then(|v| v.as_str()).unwrap_or("");
    if request_id.is_empty() {
        return Err(AppError::Other("pending_input missing request_id".into()));
    }
    // Status to restore once the answer is delivered. 'running' for the
    // main phase run; 'waiting'/'done' if the agent asked mid chat-reply.
    let prior_status = parsed
        .get("prior_status")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("running")
        .to_string();
    let question = parsed.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Find the live sidecar stdin sender (chat handle or main runner).
    let registry = app.state::<RunnerRegistry>();
    let live_tx = registry.stdin_sender(phase_id);

    if let Some(tx) = live_tx {
        // Live process: deliver the answer straight to the blocked tool
        // handler so the agent continues in the same session.
        let answer_cmd = serde_json::json!({
            "type": "answer",
            "request_id": request_id,
            "content": content,
        });
        tx.send(answer_cmd.to_string())
            .await
            .map_err(|_| AppError::Other("Failed to deliver answer to the agent.".into()))?;

        // Persist the answer into the transcript on the phase's latest session.
        let sess: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM sessions WHERE phase_id = ? ORDER BY started_at DESC LIMIT 1",
        )
        .bind(phase_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some((sid,)) = sess {
            let _ = persist_message(&state, &sid, "user", content).await;
            let _ = app.emit("message_appended", serde_json::json!({
                "session_id": sid,
                "role": "user",
                "content": content,
            }));
        }

        // Clear pending state + restore the interrupted status.
        sqlx::query("UPDATE phases SET status=?, pending_input=NULL WHERE id=?")
            .bind(&prior_status)
            .bind(phase_id)
            .execute(&state.db)
            .await?;
        emit_run_updated(app, &state, phase_id).await;
        return Ok(());
    }

    // No live process (e.g. the app was restarted while the phase was
    // paused). Resume the SDK session and feed it the answer instead of
    // forcing a phase restart. Requires a resumable SDK session id.
    let sdk_row: Option<(String,)> = sqlx::query_as(
        "SELECT sdk_session_id FROM sessions
         WHERE phase_id = ? AND sdk_session_id IS NOT NULL
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(phase_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((sdk_session_id,)) = sdk_row else {
        return Err(AppError::Config(
            "The agent process ended and its session can't be resumed. \
             Restart the phase to continue.".into(),
        ));
    };

    // Frame the answer so the agent has full context regardless of how
    // the SDK preserved the interrupted tool call.
    let framed = if question.is_empty() {
        format!(
            "Resuming after the app restarted. My answer to your question: {content}\n\n\
             Please continue from where you left off."
        )
    } else {
        format!(
            "Resuming after the app restarted. You previously asked: \"{question}\"\n\n\
             My answer: {content}\n\n\
             Please continue from where you left off."
        )
    };

    if prior_status == "running" {
        // Interrupted during the main phase run: resume as a main run so
        // the pipeline advances on completion. Record the answer in the
        // transcript ourselves (the resumed run doesn't echo it).
        if let Some((sid,)) = sqlx::query_as::<_, (String,)>(
            "SELECT id FROM sessions WHERE phase_id = ? ORDER BY started_at DESC LIMIT 1",
        )
        .bind(phase_id)
        .fetch_optional(&state.db)
        .await?
        {
            let _ = persist_message(&state, &sid, "user", content).await;
            let _ = app.emit("message_appended", serde_json::json!({
                "session_id": sid,
                "role": "user",
                "content": content,
            }));
        }
        sqlx::query("UPDATE phases SET status='running', pending_input=NULL WHERE id=?")
            .bind(phase_id)
            .execute(&state.db)
            .await?;
        emit_run_updated(app, &state, phase_id).await;
        spawn_for_phase_resume(app.clone(), phase_id.to_string(), sdk_session_id, framed);
    } else {
        // Interrupted while the agent asked mid chat-reply (phase was
        // waiting/done): resume as a chat turn so we don't re-advance an
        // already-finished phase. Restore the prior status first.
        sqlx::query("UPDATE phases SET status=?, pending_input=NULL WHERE id=?")
            .bind(&prior_status)
            .bind(phase_id)
            .execute(&state.db)
            .await?;
        emit_run_updated(app, &state, phase_id).await;
        // chat_send_reply resumes the SDK session, persists its own user
        // message, and streams the reply (no pipeline advance).
        let _ = chat_send_reply(app.clone(), phase_id.to_string(), framed).await;
    }
    Ok(())
}

/// Long-running reader for a warm chat sidecar. Forwards regular
/// events through `handle_line` and watches for the chat-specific
/// `ready` / `turn_done` events. Owns the Child so it can clean up
/// once the sidecar exits (idle timeout, EOF, or kill).
///
/// Takes the stdout reader pre-built so callers can hand off an
/// existing `Lines` instance — used by the handoff path where the
/// reader has already consumed earlier output from the same child.
async fn chat_reader_loop(
    app: AppHandle,
    session_id: String,
    phase_id: String,
    mut child: Child,
    mut reader: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    ready_tx: oneshot::Sender<()>,
) {
    let state = app.state::<AppState>();
    let mut ready_tx_opt = Some(ready_tx);
    let mut ok = false;
    let mut error_msg: Option<String> = None;
    let mut keep_alive = false; // unused in chat reader, but handle_line needs the slot

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
                            let _ = app.emit("chat_turn_state", serde_json::json!({
                                "phase_id": &phase_id,
                                "busy": false,
                            }));
                            // Wake the comment processor if it's awaiting
                            // this turn's completion.
                            app.state::<RunnerRegistry>().notify_turn(&phase_id);
                            emit_run_updated(&app, &state, &phase_id).await;
                            continue;
                        }
                        _ => {}
                    }
                }
                if !handle_line(&app, &state, &session_id, &phase_id, &line, &mut ok, &mut error_msg, &mut keep_alive).await {
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
    // Drop the pulse if we exited mid-turn (cancel / crash / EOF).
    let _ = app.emit("chat_turn_state", serde_json::json!({
        "phase_id": &phase_id,
        "busy": false,
    }));
    emit_run_updated(&app, &state, &phase_id).await;
}

/// Hand a live main-phase sidecar off to chat REPL mode. Called from
/// `run_one` after the main turn emits done with keep_alive=true: the
/// sidecar is in the middle of transitioning to its REPL loop and
/// we want to keep the process alive so the user's first chat reply
/// skips the SDK cold-start cost.
///
/// On success the chat registry is populated and the chat reader loop
/// owns the child. On failure we return the child and reader back so
/// the caller can fall through to the original wait-for-exit path —
/// no regression vs the pre-handoff behaviour.
async fn handoff_to_chat(
    app: &AppHandle,
    state: &AppState,
    phase_id: &str,
    main_session_id: &str,
    child: Child,
    reader: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    stdin_tx: Option<mpsc::Sender<String>>,
) -> Result<(), (Child, tokio::io::Lines<BufReader<tokio::process::ChildStdout>>, AppError)> {
    let registry = app.state::<RunnerRegistry>();

    // Refuse if there's already a warm chat handle for this phase.
    // Shouldn't happen on the auto-run path, but defensive.
    if registry.get_chat(phase_id).is_some() {
        return Err((child, reader, AppError::Other(
            "Chat handle already exists for this phase; declining handoff.".into(),
        )));
    }

    // The main run owns the child's stdin via a writer task; reuse that
    // sender for chat replies. If it's missing we can't drive the REPL,
    // so decline and fall back to the normal exit path.
    let Some(stdin_tx) = stdin_tx else {
        return Err((child, reader, AppError::Other(
            "Main sidecar stdin sender missing; can't hand off.".into(),
        )));
    };

    // The SDK session id was stashed onto the main session row when
    // the SDK emitted session_started. Reuse it for the chat session.
    let sdk_row: Result<Option<(Option<String>,)>, _> = sqlx::query_as(
        "SELECT sdk_session_id FROM sessions WHERE id = ?",
    )
    .bind(main_session_id)
    .fetch_optional(&state.db)
    .await;
    let sdk_session_id = match sdk_row {
        Ok(Some((Some(id),))) => id,
        _ => {
            return Err((child, reader, AppError::Other(
                "No sdk_session_id on main session row; can't hand off.".into(),
            )));
        }
    };

    // Create the chat session row that the REPL turns will append into.
    let chat_session_id = Uuid::new_v4().to_string();
    if let Err(e) = sqlx::query(
        "INSERT INTO sessions(id, phase_id, role, status, started_at, sdk_session_id, pid)
         VALUES(?, ?, 'chat', 'running', datetime('now'), ?, ?)",
    )
    .bind(&chat_session_id)
    .bind(phase_id)
    .bind(&sdk_session_id)
    .bind(child.id().map(|p| p as i64))
    .execute(&state.db)
    .await {
        return Err((child, reader, AppError::from(e)));
    }

    // Mark the main session row done — its turn is over, the REPL
    // takes over from here.
    let _ = sqlx::query("UPDATE sessions SET status='done', finished_at=datetime('now') WHERE id=?")
        .bind(main_session_id)
        .execute(&state.db)
        .await;

    // Register the chat handle (reusing the existing stdin writer) BEFORE
    // spawning the reader, so a chat_warm() called while the sidecar is
    // still emitting `ready` finds it immediately.
    registry.register_chat(phase_id.to_string(), chat_session_id.clone(), stdin_tx);

    let app_clone = app.clone();
    let phase_clone = phase_id.to_string();
    let sid_clone = chat_session_id.clone();
    let (ready_tx, _ready_rx) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        chat_reader_loop(app_clone, sid_clone, phase_clone, child, reader, ready_tx).await;
    });

    Ok(())
}


async fn run_one(
    app: &AppHandle,
    phase_id: &str,
    resume: Option<(String, String)>,
) -> AppResult<()> {
    let state = app.state::<AppState>();

    // Bail out if there's already a live runner for this phase.
    let registry = app.state::<RunnerRegistry>();
    if registry.active_session(phase_id).is_some() {
        return Ok(());
    }

    let (ctx, run_id, phase_kind) = load_phase_context(&state, phase_id).await?;

    // For implementation/review/submit, Conveyer owns a dedicated git worktree
    // on branch `<user-alias>/<slug>`. Created lazily on the first such phase
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
            &ctx.task_id,
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
    let mut cmd = node_command();
    cmd.arg(&sidecar)
        .env("CONVEYER_PHASE", &phase_kind)
        .env("CONVEYER_TASK_ID", &ctx.task_id)
        .env("CONVEYER_TASK_TITLE", &ctx.task_title)
        .env("CONVEYER_TASK_STATE", &ctx.task_state)
        .env("CONVEYER_TASK_DESCRIPTION", &ctx.task_description)
        .env("CONVEYER_SOURCE_KIND", &ctx.source_kind)
        .env("CONVEYER_TASK_REF", &ctx.source_ref)
        .env("CONVEYER_TASK_URL", &ctx.task_url)
        .env("CONVEYER_TARGET_BRANCH", ctx.base_branch_override.clone().unwrap_or_default())
        .env("CONVEYER_WORKING_BRANCH", ctx.branch_override.clone().unwrap_or_default())
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
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Resume mode: pick the SDK session back up and feed it the answer
    // instead of building a fresh prompt. Used to recover a needs_input
    // answer after the original process died.
    if let Some((sdk_sid, answer)) = &resume {
        cmd.env("CONVEYER_RESUME_SDK_SESSION", sdk_sid);
        cmd.env("CONVEYER_USER_MESSAGE", answer);
    }
    // Once the main turn succeeds the sidecar transitions to chat REPL
    // mode on the same process. The chat reader loop heartbeats every
    // 30s; this gives it 2.5 missed pings of slack before shutdown.
    cmd.env("CONVEYER_CHAT_IDLE_MS", "75000");
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
    // builds the prompt + writes prompt.md + exits. Skipped on resume:
    // the prompt.md already exists from the original run.
    if resume.is_none() {
        let mut pre = node_command();
        pre.arg(&sidecar)
            .env("CONVEYER_MODE", "render_prompt")
            .env("CONVEYER_PHASE", &phase_kind)
            .env("CONVEYER_TASK_ID", &ctx.task_id)
            .env("CONVEYER_TASK_TITLE", &ctx.task_title)
            .env("CONVEYER_TASK_STATE", &ctx.task_state)
            .env("CONVEYER_TASK_DESCRIPTION", &ctx.task_description)
            .env("CONVEYER_SOURCE_KIND", &ctx.source_kind)
            .env("CONVEYER_TASK_REF", &ctx.source_ref)
            .env("CONVEYER_TASK_URL", &ctx.task_url)
        .env("CONVEYER_TARGET_BRANCH", ctx.base_branch_override.clone().unwrap_or_default())
        .env("CONVEYER_WORKING_BRANCH", ctx.branch_override.clone().unwrap_or_default())
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

    // stdin writer for the main run, so we can deliver answers to any
    // `ask_user` / needs_input request the agent makes mid-phase. The
    // sender is kept here (and on the runner handle) so phase_submit_input
    // can reach it; on handoff to chat REPL the SAME sender is reused.
    let main_stdin_tx = if let Some(stdin) = child.stdin.take() {
        let (tx, rx) = mpsc::channel::<String>(8);
        tauri::async_runtime::spawn(chat_stdin_writer(stdin, rx));
        registry.set_runner_stdin(phase_id, tx.clone());
        Some(tx)
    } else {
        None
    };

    let mut ok = false;
    let mut error_msg: Option<String> = None;
    let mut keep_alive = false;

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
                        if !handle_line(app, &state, &session_id, phase_id, &line, &mut ok, &mut error_msg, &mut keep_alive).await {
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

    // Handoff path: the sidecar emitted done with keep_alive=true and
    // is now transitioning into chat REPL on the same process. Take
    // ownership of the live child + reader and route them into the
    // chat reader loop so the user's next chat reply skips the SDK
    // cold-start cost. complete_phase_internal still runs so the
    // pipeline advances as if the sidecar had exited.
    //
    // If anything in the handoff fails, we fall back to the original
    // wait-for-exit path — no regression.
    if ok && keep_alive {
        match handoff_to_chat(app, &state, phase_id, &session_id, child, reader, main_stdin_tx.clone()).await {
            Ok(()) => {
                // Main session row marked done inside handoff_to_chat
                // so the chat session can begin its own lifecycle.
                let send_back_reason = registry.take_send_back(phase_id);
                registry.unregister(phase_id);
                if let Some(reason) = send_back_reason {
                    let _ = crate::commands::runs::review_send_back_internal(
                        app, &state, phase_id, &reason,
                    ).await;
                } else {
                    let _ = crate::commands::runs::complete_phase_internal(app, &state, phase_id).await;
                }
                return Ok(());
            }
            Err((restored_child, restored_reader, err)) => {
                tracing::warn!("chat handoff failed for {phase_id}: {err}; falling back to normal exit");
                child = restored_child;
                reader = restored_reader;
                // fall through to normal exit path below
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
    keep_alive: &mut bool,
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
        SidecarEvent::ProposePr { title, target_branch, description, reviewers, work_items } => {
            // Source + base branch come from the run, not the agent. The base
            // branch is the remote default we cut from, so the PR target is
            // deterministic; fall back to the agent's guess only if we somehow
            // don't have one (e.g. a repo with no detectable origin).
            let run_branches: Option<(Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT r.branch_name, r.base_branch
                 FROM phases p JOIN runs r ON r.id = p.run_id WHERE p.id = ?",
            )
            .bind(phase_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
            let (source_branch, base_branch) = run_branches.unwrap_or((None, None));
            let target_branch = base_branch.or(target_branch);
            let reviewers_json = reviewers.map(|v| serde_json::to_string(&v).unwrap_or_default());
            let work_items_json = work_items.map(|v| serde_json::to_string(&v).unwrap_or_default());
            // Upsert as a draft. Don't clobber an already-created PR.
            let _ = sqlx::query(
                "INSERT INTO pull_requests
                   (phase_id, title, source_branch, target_branch, description, status,
                    reviewers_json, work_items_json, updated_at)
                 VALUES(?, ?, ?, ?, ?, 'draft', ?, ?, datetime('now'))
                 ON CONFLICT(phase_id) DO UPDATE SET
                   title=excluded.title,
                   source_branch=excluded.source_branch,
                   target_branch=excluded.target_branch,
                   description=excluded.description,
                   reviewers_json=excluded.reviewers_json,
                   work_items_json=excluded.work_items_json,
                   updated_at=datetime('now')
                 WHERE pull_requests.status IN ('draft','failed')",
            )
            .bind(phase_id)
            .bind(title.unwrap_or_default())
            .bind(&source_branch)
            .bind(&target_branch)
            .bind(&description)
            .bind(&reviewers_json)
            .bind(&work_items_json)
            .execute(&state.db)
            .await;
            let _ = app.emit("pr_changed", serde_json::json!({ "phase_id": phase_id }));
            emit_run_updated(app, state, phase_id).await;
        }
        SidecarEvent::PrCreated { number, url, status, error, checks } => {
            let checks_json = checks.map(|c| c.to_string());
            let created_ok = status == "created";
            let row_status = if created_ok { "created" } else { "failed" };
            let _ = sqlx::query(
                "UPDATE pull_requests SET status=?, number=?, url=?, error=?, checks_json=?,
                                          updated_at=datetime('now')
                 WHERE phase_id=?",
            )
            .bind(row_status)
            .bind(number)
            .bind(&url)
            .bind(&error)
            .bind(&checks_json)
            .bind(phase_id)
            .execute(&state.db)
            .await;
            if created_ok {
                // PR exists — finish the submit phase + run.
                let _ = crate::commands::runs::finalize_submit_internal(app, state, phase_id).await;
            }
            let _ = app.emit("pr_changed", serde_json::json!({ "phase_id": phase_id }));
            emit_run_updated(app, state, phase_id).await;
        }
        SidecarEvent::NeedsInput { request_id, prompt, kind, choices } => {
            let request_id = request_id.unwrap_or_else(|| Uuid::new_v4().to_string());
            // Capture the status we're interrupting so we can restore it
            // after the answer — 'running' during the main phase run, but
            // 'waiting'/'done' when the agent asks mid chat-reply.
            let prior_status: String = sqlx::query_scalar("SELECT status FROM phases WHERE id = ?")
                .bind(phase_id)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten()
                .unwrap_or_else(|| "running".to_string());
            // Persist the question as a chat message so it shows in the
            // transcript, and stash the structured request on the phase so
            // the UI can render the answer widget (and recover on reload).
            let pending = serde_json::json!({
                "request_id": request_id,
                "prompt": prompt,
                "kind": kind,
                "choices": choices,
                "prior_status": prior_status,
            });
            let _ = persist_message(state, session_id, "system", &format!("[ask] {prompt}")).await;
            let _ = app.emit("message_appended", serde_json::json!({
                "session_id": session_id,
                "role": "system",
                "content": format!("[ask] {prompt}"),
            }));
            let _ = sqlx::query(
                "UPDATE phases SET status='needs_input', pending_input=? WHERE id=?",
            )
            .bind(pending.to_string())
            .bind(phase_id)
            .execute(&state.db)
            .await;
            // Surface a notification too (drives the desktop notif + any
            // dashboard badge), mirroring the gate-pending flow.
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
            .bind(pending.to_string())
            .bind(phase_id)
            .execute(&state.db)
            .await;
            emit_run_updated(app, state, phase_id).await;
        }
        SidecarEvent::Ready | SidecarEvent::TurnDone { .. } => {
            // Chat-REPL-only events; the chat reader loop intercepts
            // them before delegating here. If they reach this dispatcher
            // (e.g. emitted in the wrong mode) just ignore.
        }
        SidecarEvent::Done { ok: done_ok, error, keep_alive: ka } => {
            *ok = done_ok;
            if !done_ok {
                *error_msg = error;
            }
            *keep_alive = done_ok && ka.unwrap_or(false);
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
        "UPDATE phases SET status='failed', finished_at=datetime('now'), pending_input=NULL WHERE id=?",
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
    // A phase paused on needs_input is recoverable: the user can still
    // answer, which resumes the SDK session. Don't fail those runs — only
    // genuinely-interrupted (running) work. We still close out the dead
    // sidecar session row so the chat stops showing a live pulse.
    let needs_input_phase_ids: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM phases WHERE status = 'needs_input'",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let recoverable: std::collections::HashSet<String> =
        needs_input_phase_ids.into_iter().map(|(id,)| id).collect();

    // Annotate + close orphaned sessions. Sessions on a needs_input phase
    // get a gentle "answer to resume" note and are marked done (not
    // failed) so they don't look broken; others get the interrupted note.
    let orphans: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, phase_id FROM sessions WHERE status = 'running'",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    for (session_id, phase_id) in &orphans {
        let is_recoverable = phase_id
            .as_deref()
            .map(|p| recoverable.contains(p))
            .unwrap_or(false);
        let note = if is_recoverable {
            "[interrupted] Conveyer was closed while the agent was waiting for your answer. Answer the question to resume."
        } else {
            "[interrupted] Conveyer was closed while this phase was running."
        };
        let _ = sqlx::query(
            "INSERT INTO messages(session_id, role, content) VALUES(?, 'system', ?)",
        )
        .bind(session_id)
        .bind(note)
        .execute(&state.db)
        .await;
    }

    // Close the dead session rows. needs_input phases -> done, others -> failed.
    sqlx::query(
        "UPDATE sessions SET status='done', finished_at=datetime('now')
         WHERE status='running'
           AND phase_id IN (SELECT id FROM phases WHERE status='needs_input')",
    )
    .execute(&state.db)
    .await?;
    sqlx::query(
        "UPDATE sessions SET status='failed', finished_at=datetime('now')
         WHERE status='running'
           AND (phase_id IS NULL OR phase_id NOT IN (SELECT id FROM phases WHERE status='needs_input'))",
    )
    .execute(&state.db)
    .await?;

    // Fail genuinely-running phases (needs_input phases are left intact).
    sqlx::query(
        "UPDATE phases SET status='failed', finished_at=datetime('now') WHERE status='running'",
    )
    .execute(&state.db)
    .await?;
    // Fail genuinely-running runs, but NOT ones still holding a needs_input
    // phase — those stay active so the user can answer + resume.
    sqlx::query(
        "UPDATE runs SET status='failed', finished_at=datetime('now')
         WHERE status='running'
           AND id NOT IN (SELECT run_id FROM phases WHERE status='needs_input')",
    )
    .execute(&state.db)
    .await?;

    if !orphans.is_empty() {
        tracing::info!(
            "reconciled {} orphaned session(s); {} recoverable (needs_input)",
            orphans.len(),
            recoverable.len(),
        );
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
