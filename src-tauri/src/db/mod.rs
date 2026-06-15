use crate::error::AppResult;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::str::FromStr;

pub type Db = SqlitePool;

/// Resolve the path to the SQLite file in the user's data dir.
/// Override with CONVEYER_DB env var (useful for tests / dev).
pub fn db_path() -> AppResult<PathBuf> {
    if let Ok(p) = std::env::var("CONVEYER_DB") {
        return Ok(PathBuf::from(p));
    }
    let base = dirs::data_dir()
        .ok_or_else(|| crate::error::AppError::Config("no data dir".into()))?;
    let dir = base.join("conveyer");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("conveyer.db"))
}

pub async fn init() -> AppResult<Db> {
    let path = db_path()?;
    let url = format!("sqlite://{}", path.display());
    let opts = SqliteConnectOptions::from_str(&url)?
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;
    run_migrations(&pool).await?;
    seed_defaults(&pool).await?;
    Ok(pool)
}

/// One-off defaults for fresh databases. Keys are only written when they
/// don't already exist, so users won't have settings clobbered after edits.
async fn seed_defaults(pool: &Db) -> AppResult<()> {
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() {
        let cb = format!("{home}/code/conveyer-test-repo");
        sqlx::query("INSERT OR IGNORE INTO settings(key, value) VALUES('codebase_path', ?)")
            .bind(&cb)
            .execute(pool)
            .await?;
    }
    Ok(())
}

async fn run_migrations(pool: &Db) -> AppResult<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .execute(pool)
    .await?;

    for (name, sql) in MIGRATIONS {
        let exists: Option<(String,)> =
            sqlx::query_as("SELECT name FROM _migrations WHERE name = ?")
                .bind(name)
                .fetch_optional(pool)
                .await?;
        if exists.is_some() {
            continue;
        }
        tracing::info!("applying migration {}", name);
        sqlx::raw_sql(sql).execute(pool).await?;
        sqlx::query("INSERT INTO _migrations(name) VALUES (?)")
            .bind(name)
            .execute(pool)
            .await?;
    }
    Ok(())
}

const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("migrations/0001_init.sql")),
    ("0002_auth", include_str!("migrations/0002_auth.sql")),
    ("0003_hierarchy", include_str!("migrations/0003_hierarchy.sql")),
    ("0004_buckets", include_str!("migrations/0004_buckets.sql")),
    ("0005_worktree", include_str!("migrations/0005_worktree.sql")),
    ("0006_workspaces", include_str!("migrations/0006_workspaces.sql")),
    ("0007_local_source", include_str!("migrations/0007_local_source.sql")),
    ("0008_review_verdict", include_str!("migrations/0008_review_verdict.sql")),
];
