-- Capture the Copilot SDK's own session id so we can resume the same
-- conversation when the user replies in chat. Our `sessions.id` is a
-- UUID we mint for our own DB tracking; the SDK keeps its session
-- state under its own id and offers `client.resumeSession(id, ...)`.
ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT;
