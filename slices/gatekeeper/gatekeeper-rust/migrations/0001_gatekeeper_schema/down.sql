-- Reverse of the rebaseline: drop everything this migration created (children
-- before parents so the DROPs pass with foreign_keys = ON). The pre-diesel
-- rusqlite schema is not restored — the up migration was destructive.
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS refresh_token_families;
DROP VIEW IF EXISTS grants;
DROP TABLE IF EXISTS device_grants;
DROP TABLE IF EXISTS authorization_code_grants;
DROP TABLE IF EXISTS authorization_codes;
DROP TABLE IF EXISTS authorization_requests;
DROP TABLE IF EXISTS signing_keys;
DROP TABLE IF EXISTS clients;
