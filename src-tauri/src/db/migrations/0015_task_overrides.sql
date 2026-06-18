-- Per-task overrides for run behavior. All NULL by default — meaning
-- "inherit the global setting" — so existing tasks are unaffected.
--
--   use_worktree         0/1 — overrides settings.use_worktree
--   base_branch_override TEXT — overrides remote default branch (PR base + diff base)
--   branch_override      TEXT — work on this existing branch instead of creating
--                              `<alias>/<slug>`. No new branch is created.
--   enable_submit        0/1 — overrides settings.phase_submit_enabled
ALTER TABLE tasks ADD COLUMN use_worktree INTEGER;
ALTER TABLE tasks ADD COLUMN base_branch_override TEXT;
ALTER TABLE tasks ADD COLUMN branch_override TEXT;
ALTER TABLE tasks ADD COLUMN enable_submit INTEGER;
