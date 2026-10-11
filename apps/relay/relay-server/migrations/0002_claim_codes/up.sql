-- Claim codes issued through the admin API
-- (`POST /api/tunnels/{name}/claim-codes`): each redeems once, at
-- `POST /claim`, for its tunnel's name and token. A tunnel has at most one
-- outstanding code: issuing another replaces its row, so the earlier code
-- stops redeeming. `code_hash` is the SHA-256 of the code's eight characters
-- (uppercase, without the dash); the code itself is never stored.
-- `expires_at` is Unix epoch seconds: the code redeems while the relay's
-- clock reads earlier. Deleting the tunnel deletes its code.
CREATE TABLE claim_codes (
    tunnel_name TEXT PRIMARY KEY NOT NULL REFERENCES tunnels (name) ON DELETE CASCADE,
    code_hash BLOB NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
) STRICT;
