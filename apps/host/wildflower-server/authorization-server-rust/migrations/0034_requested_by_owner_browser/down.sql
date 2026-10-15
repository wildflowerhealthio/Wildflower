-- Reverse of up.sql. SQLite's in-place `DROP COLUMN` (3.35+) applies: the
-- column is in no index, key or CHECK.
ALTER TABLE authorization_requests DROP COLUMN requested_by_owner_browser;
