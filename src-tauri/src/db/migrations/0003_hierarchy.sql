-- Hierarchy + description support.
-- parent_ref       : source_ref of the parent work item (same source). Nullable.
-- is_self_assigned : 1 when this work item was discovered as @me, 0 when only
--                    pulled in as a parent for hierarchy context.
-- description      : raw HTML (System.Description) for display.
ALTER TABLE tasks ADD COLUMN parent_ref       TEXT;
ALTER TABLE tasks ADD COLUMN is_self_assigned INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN description      TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(source_id, parent_ref);
