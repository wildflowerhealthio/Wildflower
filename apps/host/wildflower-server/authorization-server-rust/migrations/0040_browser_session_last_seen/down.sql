-- Reverse of up.sql. SQLite's in-place `DROP COLUMN` (3.35+) applies: the
-- column is in no index, key or CHECK.
ALTER TABLE browser_sessions DROP COLUMN last_seen_at;
