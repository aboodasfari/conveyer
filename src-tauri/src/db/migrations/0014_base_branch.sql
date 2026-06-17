-- Record the remote base branch the run was cut from (e.g. "main"), so the
-- submit phase can target it deterministically instead of the agent guessing
-- the PR target. base_sha already stores the exact commit we branched from.
ALTER TABLE runs ADD COLUMN base_branch TEXT;
