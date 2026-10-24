-- Reverse of `up.sql`. Never run at runtime (the store only ever rolls
-- migrations forward); present because the diesel migration harness expects a
-- `down.sql` per migration. Codes that name no tunnel are dropped.
CREATE TABLE claim_codes_named (
    tunnel_name TEXT PRIMARY KEY NOT NULL REFERENCES tunnels (name) ON DELETE CASCADE,
    code_hash BLOB NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
) STRICT;

INSERT INTO claim_codes_named (tunnel_name, code_hash, expires_at)
SELECT tunnel_name, code_hash, expires_at FROM claim_codes WHERE tunnel_name IS NOT NULL;

DROP TABLE claim_codes;

ALTER TABLE claim_codes_named RENAME TO claim_codes;
