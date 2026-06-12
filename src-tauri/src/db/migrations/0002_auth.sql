-- Add auth mode + optional account hint to sources.
-- auth_kind ∈ 'pat' | 'entra' (azure entra id via local `az` CLI)
ALTER TABLE sources ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'pat';
-- Optional: which az account to use (empty = default). Useful if user is
-- signed in to multiple tenants.
ALTER TABLE sources ADD COLUMN az_account TEXT NOT NULL DEFAULT '';
