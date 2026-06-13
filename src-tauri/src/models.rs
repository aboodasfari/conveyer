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
