use crate::ado;
use crate::ado::auth::{header_value, AuthInputs, AuthKind};
use crate::error::AppResult;
use crate::github;
use crate::models::{AdoSourceConfig, GithubSourceConfig, Source};
use crate::state::AppState;
use serde::Deserialize;
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct SourceInput {
    pub kind: String,
    pub name: String,
    pub config_json: String,
    pub pat_env: String,
    pub enabled: bool,
    pub auth_kind: String,   // 'pat' | 'entra'
    pub az_account: String,  // optional, empty = default
}

const SOURCE_COLS: &str =
    "id, kind, name, config_json, pat_env, enabled, created_at, auth_kind, az_account";

#[tauri::command]
pub async fn sources_list(state: State<'_, AppState>) -> AppResult<Vec<Source>> {
    let rows = sqlx::query_as::<_, Source>(&format!(
        "SELECT {SOURCE_COLS} FROM sources ORDER BY created_at"
    ))
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[tauri::command]
pub async fn sources_upsert(state: State<'_, AppState>, input: SourceInput) -> AppResult<Source> {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sources(id, kind, name, config_json, pat_env, enabled, auth_kind, az_account)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&input.kind)
    .bind(&input.name)
    .bind(&input.config_json)
    .bind(&input.pat_env)
    .bind(input.enabled as i64)
    .bind(&input.auth_kind)
    .bind(&input.az_account)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, Source>(&format!(
        "SELECT {SOURCE_COLS} FROM sources WHERE id = ?"
    ))
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

#[tauri::command]
pub async fn sources_update(
    state: State<'_, AppState>,
    id: String,
    input: SourceInput,
) -> AppResult<Source> {
    sqlx::query(
        "UPDATE sources SET kind=?, name=?, config_json=?, pat_env=?, enabled=?,
                              auth_kind=?, az_account=? WHERE id=?",
    )
    .bind(&input.kind)
    .bind(&input.name)
    .bind(&input.config_json)
    .bind(&input.pat_env)
    .bind(input.enabled as i64)
    .bind(&input.auth_kind)
    .bind(&input.az_account)
    .bind(&id)
    .execute(&state.db)
    .await?;
    let row = sqlx::query_as::<_, Source>(&format!(
        "SELECT {SOURCE_COLS} FROM sources WHERE id=?"
    ))
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

#[tauri::command]
pub async fn sources_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sqlx::query("DELETE FROM sources WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Validate a source's auth + reachability without persisting it.
/// Used by the Settings form to give immediate feedback on Add.
#[tauri::command]
pub async fn sources_test(input: SourceInput) -> AppResult<()> {
    match input.kind.as_str() {
        "ado" => {
            let cfg: AdoSourceConfig = serde_json::from_str(&input.config_json)?;
            let auth = header_value(AuthInputs {
                kind: AuthKind::parse(&input.auth_kind),
                pat_env: &input.pat_env,
                az_account: &input.az_account,
            })
            .await?;
            ado::ping(&cfg, &auth).await
        }
        "github" => {
            let cfg: GithubSourceConfig = serde_json::from_str(&input.config_json)?;
            let token = github::auth::token(
                github::auth::GithubAuthKind::parse(&input.auth_kind),
                &input.pat_env,
            )
            .await?;
            github::ping(&cfg, &token).await
        }
        other => Err(crate::error::AppError::Config(format!(
            "unsupported source kind {other}"
        ))),
    }
}
