use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Source {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub config_json: String,
    pub pat_env: String,
    pub enabled: i64,
    pub created_at: String,
    pub auth_kind: String,   // 'pat' | 'entra'
    pub az_account: String,  // optional subscription/account hint
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdoSourceConfig {
    pub org: String,
    pub project: String,
    pub team: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubSourceConfig {
    pub owner: String,
    #[serde(default)]
    pub repo: Option<String>,
    /// GitHub host. Empty / "github.com" = public GitHub. For GitHub
    /// Enterprise set the instance host (e.g. "github.acme.com" for a
    /// self-hosted server, or "acme.ghe.com" for data residency).
    #[serde(default)]
    pub host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Task {
    pub id: String,
    pub source_id: String,
    pub source_ref: String,
    pub title: String,
    pub state: String,
    pub url: String,
    pub source_meta_json: String,
    pub discovered_at: String,
    pub updated_at: String,
    pub parent_ref: Option<String>,
    pub is_self_assigned: i64,
    pub description: Option<String>,
    pub bucket: String,
    pub workspace_path: Option<String>,
    /// Per-task override: NULL = inherit `settings.use_worktree`, else 0/1.
    pub use_worktree: Option<i64>,
    /// Per-task override for the PR target / diff base. NULL = auto-detect
    /// from the remote default branch.
    pub base_branch_override: Option<String>,
    /// Per-task override: name of an existing branch to work on. NULL = create
    /// a new branch as `<alias>/<slug>`.
    pub branch_override: Option<String>,
    /// Per-task override: NULL = inherit `settings.phase_submit_enabled`,
    /// else 0/1.
    pub enable_submit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Run {
    pub id: String,
    pub task_id: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Phase {
    pub id: String,
    pub run_id: String,
    pub kind: String,
    pub ord: i64,
    pub status: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub artifact_path: Option<String>,
    pub review_verdict: Option<String>,
    pub review_reason: Option<String>,
    /// JSON blob describing a pending `ask_user` request when status is
    /// 'needs_input': {request_id, prompt, choices, kind}.
    pub pending_input: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Gate {
    pub phase_kind: String,
    pub auto_advance: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Notification {
    pub id: String,
    pub task_id: Option<String>,
    pub session_id: Option<String>,
    pub kind: String,
    pub payload_json: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

pub const PHASE_KINDS: &[&str] = &[
    "exploration",
    "planning",
    "implementation",
    "review",
    "submit",
];
