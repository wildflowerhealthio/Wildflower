-- Reverse of up.sql. SQLite's in-place `DROP COLUMN` (3.35+) applies: the
-- columns are in no index, key or CHECK.
ALTER TABLE clients DROP COLUMN refresh_ends_with_browser_session;
ALTER TABLE clients DROP COLUMN refresh_max_ttl_seconds;
ALTER TABLE clients DROP COLUMN refresh_idle_ttl_seconds;
