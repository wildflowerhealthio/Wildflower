-- Reverse of up.sql. SQLite's in-place `DROP COLUMN` (3.35+) applies: the
-- column is in no index, key or CHECK.
DROP TABLE IF EXISTS session_shortfall_acknowledgements;
ALTER TABLE authorization_requests DROP COLUMN session_shortfall_acknowledged;
