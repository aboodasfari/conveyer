-- Per-task display bucket. Lets users tuck stories away into Backlog or
-- Archive lists so the active dashboard stays clean. Children inherit the
-- bucket of their parent (enforced at the IPC layer, not in SQL).
ALTER TABLE tasks ADD COLUMN bucket TEXT NOT NULL DEFAULT 'active';
CREATE INDEX IF NOT EXISTS idx_tasks_bucket ON tasks(source_id, bucket);
