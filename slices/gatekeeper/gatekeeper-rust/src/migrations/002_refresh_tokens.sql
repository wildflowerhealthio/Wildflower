-- Rotating refresh tokens (RFC 6749 §6, OAuth 2.1 rotation semantics).
-- Family-level facts (client, scopes, patient, absolute deadline) live
-- exactly once on refresh_token_families; refresh_tokens holds one row per
-- rotation generation, keyed by the SHA-256 digest of the plaintext (which
-- is never stored). Generations are kept after consumption (consumed_at
-- set) so a replayed token still resolves to its family and revokes the
-- whole lineage.
CREATE TABLE refresh_token_families (
    family_id TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    patient TEXT,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX refresh_token_families_client_id_idx
    ON refresh_token_families(client_id);

CREATE TABLE refresh_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL,
    family_id TEXT NOT NULL REFERENCES refresh_token_families(family_id),
    issued_at TEXT NOT NULL,
    consumed_at TEXT
);

CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens(family_id);
