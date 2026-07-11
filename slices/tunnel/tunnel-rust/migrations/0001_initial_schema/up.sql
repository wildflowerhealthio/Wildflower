-- Singleton tunnel settings row (id is always 'tunnel'). Holds the host
-- configuration (public_host / requested_running) plus the write-only relay
-- connection details the rathole client dials, and a monotonically increasing
-- `revision` used as the optimistic-concurrency token for PUT /tunnel.
--
-- The row is seeded here so every read finds it and every write is a plain
-- UPDATE guarded on `revision` (no upsert, no read-modify-write). `public_host`
-- is the full public hostname (e.g. dev1.example.com) the relay edge serves
-- this device at; it drives servedOrigin and is shown to the user. The relay_*
-- columns + service_name are write-only — set through the API, never returned
-- on the wire.
--
-- IDEMPOTENT DDL (`IF NOT EXISTS` / `INSERT OR IGNORE`): unlike a brand-new
-- table, `tunnel_settings` predates this diesel migration — it was created by
-- the retired `persistence-rust` namespaced migration runner. On a database
-- built by that runner the table (and its singleton row) already exist, and
-- diesel — which tracks applied versions in its own `__diesel_schema_migrations`
-- table, disjoint from the old `schema_migrations` — would otherwise fail
-- applying `0001` against the existing table. The guards make this migration a
-- no-op on such a database while still creating the table + seed on a fresh one,
-- producing the exact schema the retired runner did.
CREATE TABLE IF NOT EXISTS tunnel_settings (
    id                TEXT PRIMARY KEY,
    revision          INTEGER NOT NULL DEFAULT 0,
    public_host       TEXT,
    requested_running INTEGER NOT NULL DEFAULT 0,
    relay_remote_addr TEXT,
    relay_token       TEXT,
    relay_public_key  TEXT,
    service_name      TEXT
) STRICT;

INSERT OR IGNORE INTO tunnel_settings (id) VALUES ('tunnel');
