-- Conveyer initial schema. Designed to allow future non-ADO sources
-- without migrations: source-specific fields live in *_meta JSON blobs.

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,             -- 'ado' for v1
    name         TEXT NOT NULL,
    config_json  TEXT NOT NULL,             -- {org, project, team, ...}
    pat_env      TEXT NOT NULL,             -- env var name holding PAT
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
    id               TEXT PRIMARY KEY,
    source_id        TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    source_ref       TEXT NOT NULL,         -- e.g. ADO work item id as string
    title            TEXT NOT NULL,
    state            TEXT NOT NULL,         -- raw source state (e.g. 'New')
    url              TEXT NOT NULL,
    source_meta_json TEXT NOT NULL DEFAULT '{}',
    discovered_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (source_id, source_ref)
);

CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source_id);
CREATE INDEX IF NOT EXISTS idx_tasks_state  ON tasks(state);

CREATE TABLE IF NOT EXISTS runs (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'pending', -- pending|running|waiting|done|failed|cancelled
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);

CREATE TABLE IF NOT EXISTS phases (
    id            TEXT PRIMARY KEY,
    run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,            -- exploration|planning|implementation|review|submit
    ord           INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending', -- pending|running|waiting|done|failed|skipped
    started_at    TEXT,
    finished_at   TEXT,
    artifact_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_phases_run ON phases(run_id);

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    phase_id   TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,               -- main|coder|tester|reviewer
    status     TEXT NOT NULL DEFAULT 'pending',
    pid        INTEGER,
    log_path   TEXT,
    started_at TEXT,
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_phase ON sessions(phase_id);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ts         TEXT NOT NULL DEFAULT (datetime('now')),
    role       TEXT NOT NULL,               -- user|assistant|system|tool
    content    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS gates (
    phase_kind   TEXT PRIMARY KEY,
    auto_advance INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO gates(phase_kind, auto_advance) VALUES
    ('exploration', 1),
    ('planning', 0),
    ('implementation', 0),
    ('review', 0),
    ('submit', 0);

CREATE TABLE IF NOT EXISTS notifications (
    id           TEXT PRIMARY KEY,
    task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    session_id   TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,             -- needs_input|gate_pending|error
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at  TEXT
);
