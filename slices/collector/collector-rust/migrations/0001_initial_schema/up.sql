-- The remotes table: one row per user-visible remote on the
-- `/collector/remotes` surface. `config` is the full tagged `CollectorConfig`
-- JSON, opaque to Rust (the per-collector union is TS-owned — see
-- collector-registry's registry); `tag` is denormalized from `config._tag` at
-- write time so kind-filtering reads never crack the JSON. `added_at` is
-- ISO-8601 UTC with milliseconds, the encoding the TS `Schema.DateTimeUtc`
-- round-trips.
--
-- SECURITY (decided for v1, see the Rexall collector epic): a remote's config
-- may carry pharmacy credentials, stored plaintext inside the JSON. Moving
-- secrets to OS keychain / encrypted storage is a tracked follow-up.
CREATE TABLE collector_remotes (
    -- A non-INTEGER PRIMARY KEY still permits NULL in SQLite (a historical
    -- quirk STRICT does not override), so pin NOT NULL explicitly.
    id       TEXT PRIMARY KEY NOT NULL,
    name     TEXT NOT NULL,
    tag      TEXT NOT NULL,
    config   TEXT NOT NULL,
    added_at TEXT NOT NULL
) STRICT;
