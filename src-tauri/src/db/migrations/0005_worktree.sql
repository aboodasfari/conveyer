-- Persist the worktree we create for the implementation phase so subsequent
-- phases (review, submit) operate on the same checkout and the Diff tab can
-- compute `git diff base..HEAD`.
ALTER TABLE runs ADD COLUMN worktree_path TEXT;
ALTER TABLE runs ADD COLUMN branch_name   TEXT;
ALTER TABLE runs ADD COLUMN base_sha      TEXT;
