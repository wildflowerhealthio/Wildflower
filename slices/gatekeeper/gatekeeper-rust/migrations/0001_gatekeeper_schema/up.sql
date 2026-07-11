-- The gatekeeper schema, rebaselined for diesel. This crate's store moved from
-- rusqlite (persistence-rust's namespaced `schema_migrations` runner, eleven
-- incremental migrations) to Diesel over the app-wide r2d2 pool; this one
-- migration recreates the final shape under diesel's own bookkeeping
-- (`__diesel_schema_migrations`). DESTRUCTIVE BY DESIGN (decided with the
-- product owner, 2026-07-11): pre-release data is dropped, not copied — the
-- DROPs clear any tables the old rusqlite migrations created. The old
-- `schema_migrations` rows under the `gatekeeper` namespace are left behind
-- (the table belongs to the other slices' runner and may not exist on a fresh
-- database, so this migration cannot portably touch it); nothing reads them.
--
-- Grants are ONE TABLE PER CONCRETE KIND (replacing the class-table
-- inheritance of old migration 010 — parent `grants` + child payload tables):
-- `authorization_code_grants` and `device_grants` each carry ALL their
-- columns, shared and payload alike, so single-kind operations (upserts,
-- keyed lookups, deletes) are single-table statements with no cross-table
-- transactions and no parent-implies-child invariant to enforce. Cross-kind
-- reads go through the `grants` VIEW below.

-- Children before parents (`refresh_tokens` references `refresh_token_families`;
-- the old grant child tables referenced the old `grants` parent) so the DROPs
-- pass with `foreign_keys = ON`.
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS refresh_token_families;
DROP TABLE IF EXISTS authorization_code_grants;
DROP TABLE IF EXISTS device_grants;
DROP TABLE IF EXISTS grants;
DROP TABLE IF EXISTS authorization_codes;
DROP TABLE IF EXISTS authorization_requests;
DROP TABLE IF EXISTS signing_keys;
DROP TABLE IF EXISTS clients;

-- Registered OAuth clients: identity + policy, looked up by `client_id` at
-- every `/oauth/*` boundary. The three list columns are compact JSON TEXT;
-- `kind` is the lowercase `ClientKind` discriminant; timestamps are the
-- diesel chrono text encoding (`%F %T%.f%:z`).
CREATE TABLE clients (
    -- A non-INTEGER PRIMARY KEY still permits NULL in SQLite (a historical
    -- quirk STRICT does not override), so pin NOT NULL explicitly — here and
    -- on every other table below.
    client_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    allowed_scopes TEXT NOT NULL,
    allowed_grant_types TEXT NOT NULL,
    secret_hash TEXT,
    registered_at TEXT NOT NULL,
    disabled_at TEXT
) STRICT;

-- RSA signing keys backing JWS signatures and the JWKS endpoint. `is_active`
-- selects the current minter; verify-side iterates every key for rotation.
CREATE TABLE signing_keys (
    kid TEXT PRIMARY KEY NOT NULL,
    kty TEXT NOT NULL,
    alg TEXT NOT NULL,
    values_json TEXT NOT NULL,
    is_active INTEGER NOT NULL
) STRICT;

-- In-flight OAuth authorizations, both flows: `grant_type` discriminates, the
-- optional columns belong to one flow or the other (PKCE/redirect for the
-- code flow, user_code/device_name for the device flow).
CREATE TABLE authorization_requests (
    id TEXT PRIMARY KEY NOT NULL,
    grant_type TEXT NOT NULL,
    client_id TEXT NOT NULL,
    requested_scopes TEXT NOT NULL,
    code_challenge TEXT,
    code_challenge_method TEXT,
    redirect_uri TEXT,
    client_state TEXT,
    user_code TEXT,
    pre_approved_scopes TEXT NOT NULL DEFAULT '[]',
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_polled_at TEXT,
    status TEXT NOT NULL,
    granted_scopes TEXT,
    patient TEXT,
    device_name TEXT
) STRICT;

CREATE INDEX authorization_requests_user_code_idx
    ON authorization_requests(user_code);

-- At most one *pending* request per user_code (old migration 005): a partial
-- unique index keeps terminal rows free to share a code while a second live
-- duplicate is a hard error rather than silent ambiguity at the consent
-- loader's single-row read.
CREATE UNIQUE INDEX authorization_requests_pending_user_code_uidx
    ON authorization_requests(user_code)
    WHERE status = 'pending' AND user_code IS NOT NULL;

-- Single-use codes redeemed at `/token` (RFC 6749 §4.1.2).
CREATE TABLE authorization_codes (
    code TEXT PRIMARY KEY NOT NULL,
    request_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    granted_scopes TEXT NOT NULL,
    patient TEXT,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
) STRICT;

-- One code per request (old migration 004): the Owner-UI polling endpoint
-- reads a single row by request_id, so a double-issue must be a hard error.
CREATE UNIQUE INDEX authorization_codes_request_id_idx
    ON authorization_codes(request_id);

-- Standing authorization-code consents: "client X may ask for scopes Y at
-- redirect URI Z without re-prompting". The UNIQUE(client_id, redirect_uri)
-- upsert-identity key (old migration 006) makes concurrent approvals
-- race-safe — two can't both insert.
CREATE TABLE authorization_code_grants (
    id TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    last_used_at TEXT,
    patient TEXT,
    redirect_uri TEXT NOT NULL,
    UNIQUE (client_id, redirect_uri)
) STRICT;

-- Standing device pairings: the durable record of an approved device-code
-- flow, keyed on the human-facing device name. `device_name` is NOT NULL —
-- an unnamed device defaults to its client's name at mint time, so the
-- UNIQUE(client_id, device_name) upsert key stays total (SQLite treats NULLs
-- as distinct in UNIQUE indexes).
CREATE TABLE device_grants (
    id TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    last_used_at TEXT,
    patient TEXT,
    device_name TEXT NOT NULL,
    UNIQUE (client_id, device_name)
) STRICT;

-- Cross-kind reads (the Owner UI's access index, lookups by bare grant id) go
-- through this UNION ALL view: the shared columns, a kind tag, and each
-- kind's payload column NULL for the other kind. Grant ids are UUIDs minted
-- at upsert time, so they are unique across both tables and a by-id read
-- through the view returns at most one row.
CREATE VIEW grants AS
    SELECT id, client_id, scopes, granted_at, last_used_at, patient,
           'authorization_code' AS grant_type,
           redirect_uri,
           NULL AS device_name
    FROM authorization_code_grants
    UNION ALL
    SELECT id, client_id, scopes, granted_at, last_used_at, patient,
           'device_code' AS grant_type,
           NULL AS redirect_uri,
           device_name
    FROM device_grants;

-- Rotating refresh tokens (RFC 6749 §6, OAuth 2.1 rotation semantics).
-- Family-level facts live exactly once on refresh_token_families;
-- refresh_tokens holds one row per rotation generation, keyed by the SHA-256
-- digest of the plaintext (never stored). Generations are kept after
-- consumption so a replayed token still resolves to its family and revokes
-- the whole lineage. `authorization_code_hash` (old migration 003) links a
-- family to the code that minted it for code-replay revocation;
-- `grant_id` (old migration 011) is a deliberate SOFT reference to the grant
-- that authorized the family — families outlive grants by design (revocation
-- expires a family in place, never deletes it), so no foreign key.
CREATE TABLE refresh_token_families (
    family_id TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    patient TEXT,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    authorization_code_hash TEXT,
    grant_id TEXT
) STRICT;

CREATE INDEX refresh_token_families_client_id_idx
    ON refresh_token_families(client_id);
CREATE INDEX refresh_token_families_authorization_code_hash_idx
    ON refresh_token_families(authorization_code_hash);
CREATE INDEX refresh_token_families_grant_id_idx
    ON refresh_token_families(grant_id);

CREATE TABLE refresh_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL,
    family_id TEXT NOT NULL REFERENCES refresh_token_families(family_id),
    issued_at TEXT NOT NULL,
    consumed_at TEXT
) STRICT;

CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens(family_id);
