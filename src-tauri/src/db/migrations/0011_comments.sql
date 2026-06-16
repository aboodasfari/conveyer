-- Review comments left on the diff while a phase is gated (waiting). Each
-- row is one comment in a thread; the agent addresses them one at a time
-- and may reply. `commit_marker` is the stable tag the agent puts in the
-- commit message so follow-ups in the same thread amend that commit
-- instead of stacking new ones.
CREATE TABLE IF NOT EXISTS comments (
    id            TEXT PRIMARY KEY,
    phase_id      TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    line_start    INTEGER,
    line_end      INTEGER,
    side          TEXT,                       -- 'old' | 'new'
    snippet       TEXT,                       -- the highlighted diff text
    body          TEXT NOT NULL,              -- the user's comment(s), thread-joined
    status        TEXT NOT NULL DEFAULT 'queued', -- queued|working|addressed|accepted
    agent_reply   TEXT,                       -- agent's short reply, latest turn
    commit_marker TEXT NOT NULL,              -- stable [conveyer-comment:<marker>] tag
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (phase_id) REFERENCES phases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comments_phase ON comments(phase_id);
