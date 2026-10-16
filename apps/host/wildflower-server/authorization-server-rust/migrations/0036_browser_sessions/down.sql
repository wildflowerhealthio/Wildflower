-- Reverse of up.sql. SQLite's in-place `DROP COLUMN` (3.35+) applies once the
-- index on `refresh_token_families.sid` is gone; the other two columns are in
-- no index, key or CHECK.
DROP INDEX IF EXISTS refresh_token_families_sid_idx;
ALTER TABLE refresh_token_families DROP COLUMN sid;
ALTER TABLE authorization_codes DROP COLUMN sid;
ALTER TABLE authorization_requests DROP COLUMN sid;
DROP TABLE IF EXISTS browser_sessions;
