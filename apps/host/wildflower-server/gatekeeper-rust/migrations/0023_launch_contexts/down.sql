-- Reverse of up.sql. SQLite's in-place `DROP COLUMN` (3.35+) applies: neither
-- column is in an index, key or CHECK.
ALTER TABLE authorization_requests DROP COLUMN launch_bound_patient;
ALTER TABLE authorization_requests DROP COLUMN launch;
DROP TABLE IF EXISTS launch_contexts;
