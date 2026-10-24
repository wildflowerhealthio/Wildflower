-- Claim codes that name no tunnel. A claim code either names its tunnel
-- (`tunnel_name` set: it redeems at `POST /claim` for that tunnel's name and
-- token, and a tunnel has at most one outstanding code) or names none
-- (`tunnel_name` NULL: it redeems once, with an email and an optional name,
-- for a new tunnel). `claim_codes` is rebuilt so `code_hash` is the primary
-- key and `tunnel_name` may be NULL; SQLite cannot change either in place.
-- `UNIQUE` lets any number of rows have a NULL `tunnel_name`.
CREATE TABLE claim_codes_rebuilt (
    code_hash BLOB PRIMARY KEY NOT NULL,
    tunnel_name TEXT UNIQUE REFERENCES tunnels (name) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
) STRICT;

INSERT INTO claim_codes_rebuilt (code_hash, tunnel_name, expires_at)
SELECT code_hash, tunnel_name, expires_at FROM claim_codes;

DROP TABLE claim_codes;

ALTER TABLE claim_codes_rebuilt RENAME TO claim_codes;
