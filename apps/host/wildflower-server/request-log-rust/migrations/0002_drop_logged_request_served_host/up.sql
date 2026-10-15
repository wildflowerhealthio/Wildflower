-- Drop `logged_requests.served_host`. Every request is served at the server's
-- one origin, so every row the writer adds holds the same host, the server's
-- domain, and the column carries no information.
--
-- The column is in no index, key, or CHECK, so SQLite's in-place `DROP COLUMN`
-- (3.35+; the bundled SQLite is 3.47) applies.

ALTER TABLE logged_requests DROP COLUMN served_host;
