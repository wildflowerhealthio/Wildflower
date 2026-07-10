-- Make `grants` polymorphic: a parent registry row plus a per-variant child
-- table, discriminated by a `grant_type` column — the same shape the apps slice
-- uses (`apps` + `cloud_apps`/`self_hosted_apps`). See
-- docs/Persistence/Polymorphic Rows Explanation.md.
--
-- Before this migration the flat `grants` row only modelled the authorization-
-- code flow (its `redirect_uri` keys the consent-skip fast path). Device-code
-- pairings minted no durable record at all. Splitting the table lets each flow
-- keep its own NOT NULL invariants (`redirect_uri` for code grants, `device_name`
-- for device grants) in its own child table.
--
-- `client_id` is deliberately denormalized onto each child so the per-variant
-- UNIQUE indexes can live there (SQLite can't index across a parent+child JOIN).
-- The invariant `child.client_id == parent.client_id` is upheld by writing the
-- parent and child in one transaction — see `upsert_grant` / `upsert_device_grant`
-- / `create_grant` in db/grants.rs.

-- Rename the flat table aside so its rows can be copied into the new shape. Its
-- `grants_client_id_redirect_uri_idx` UNIQUE index (migration 006) rides along on
-- the rename and is dropped with the table at the end.
ALTER TABLE grants RENAME TO grants_old;

-- Parent registry: the fields shared by every grant, plus the discriminator.
-- `redirect_uri` is gone — it now lives on the authorization-code child. The
-- CHECK pins `grant_type` to the same wire strings as the `GrantType` enum
-- (`domain/authorization_request.rs`), which is reused for the column mapping.
CREATE TABLE grants (
    id TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    last_used_at TEXT,
    patient TEXT,
    grant_type TEXT NOT NULL CHECK (grant_type IN ('authorization_code', 'device_code'))
);

-- Authorization-code child: the exact `redirect_uri` the grant covers. The
-- UNIQUE(client_id, redirect_uri) preserves the race-safety property migration
-- 006 established — two concurrent approvals for the same pair can't both insert.
CREATE TABLE authorization_code_grants (
    id TEXT PRIMARY KEY NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    UNIQUE (client_id, redirect_uri)
);

-- Device child: the human-facing `device_name` the pairing is keyed on. NOT
-- NULL — an unnamed device defaults to its client's name at mint time, so the
-- upsert key `(client_id, device_name)` stays total (a NULL would break the
-- UNIQUE index: SQLite treats NULLs as distinct).
CREATE TABLE device_grants (
    id TEXT PRIMARY KEY NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    UNIQUE (client_id, device_name)
);

-- Every pre-existing grant was an authorization-code grant. Copy the shared
-- columns into the parent (parent first so the child FK resolves) …
INSERT INTO grants (id, client_id, scopes, granted_at, last_used_at, patient, grant_type)
    SELECT id, client_id, scopes, granted_at, last_used_at, patient, 'authorization_code'
    FROM grants_old;

-- … then move each row's `redirect_uri` into its authorization-code child.
INSERT INTO authorization_code_grants (id, client_id, redirect_uri)
    SELECT id, client_id, redirect_uri
    FROM grants_old;

DROP TABLE grants_old;
