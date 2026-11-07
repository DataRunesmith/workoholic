-- Dashboard identity moved from GitHub OAuth to Cloudflare Access.
-- New saves record the Access email; updated_by_github_id is kept as history.
ALTER TABLE runtime_configuration ADD COLUMN updated_by TEXT;
