-- Singleton 'local' source for ad-hoc tasks created in-app, separate
-- from any external (ADO etc.) sources. Created idempotently here so
-- the local-task create command can rely on it existing without bootstrap.
INSERT INTO sources(id, kind, name, config_json, pat_env, enabled, auth_kind, az_account)
SELECT 'local', 'local', 'Local', '{}', '', 1, 'pat', ''
WHERE NOT EXISTS (SELECT 1 FROM sources WHERE id = 'local');
