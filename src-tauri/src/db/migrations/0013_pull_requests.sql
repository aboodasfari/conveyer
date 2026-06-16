-- One proposed/created pull request per submit phase. The submit phase
-- first DRAFTS the PR (status='draft') and shows it as a preview; on the
-- user's approval the agent actually creates it (status='creating' ->
-- 'created'|'failed'). number/url/checks are filled once created.
CREATE TABLE IF NOT EXISTS pull_requests (
    phase_id        TEXT PRIMARY KEY,
    title           TEXT NOT NULL DEFAULT '',
    source_branch   TEXT,
    target_branch   TEXT,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'draft', -- draft|creating|created|failed
    number          INTEGER,
    url             TEXT,
    checks_json     TEXT,   -- JSON array of {name, status}
    reviewers_json  TEXT,   -- JSON array of strings
    work_items_json TEXT,   -- JSON array of strings
    error           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (phase_id) REFERENCES phases(id) ON DELETE CASCADE
);
