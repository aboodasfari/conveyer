-- When the agent calls the `ask_user` tool mid-phase, we stash the
-- pending request here (JSON: {request_id, prompt, choices, kind}) and
-- flip the phase status to 'needs_input'. The UI renders an answer
-- widget; on answer we write the reply back over the sidecar's stdin,
-- clear this column, and flip the phase back to 'running'. Cleared on
-- cancel / restart / completion so a stale prompt never lingers.
ALTER TABLE phases ADD COLUMN pending_input TEXT;
