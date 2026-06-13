-- Workspaces are the named code repos Conveyer can run agents against.
-- Replaces the singleton `codebase_path` setting with a proper list, and
-- gives each task an explicit `workspace_path` so different tasks can
-- target different repos.
CREATE TABLE IF NOT EXISTS workspaces (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE tasks ADD COLUMN workspace_path TEXT;

-- One-shot migration of the existing singleton setting into a workspace.
-- Only inserts if there's a non-empty codebase_path and no workspace
-- already uses that path.
INSERT INTO workspaces(name, path)
SELECT 'Default', s.value
FROM settings s
WHERE s.key = 'codebase_path'
  AND s.value IS NOT NULL
  AND s.value <> ''
  AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.path = s.value);
