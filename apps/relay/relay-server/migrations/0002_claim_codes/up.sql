-- Claim codes issued through the admin API
-- (`POST /api/tunnels/{name}/claim-codes`): each redeems once, at
-- `POST /claim`, for its tunnel's name and token. `code_hash` is the SHA-256
-- of the code's eight characters (uppercase, without the dash); the code
-- itself is never stored. `expires_at` is Unix epoch seconds: the code
-- redeems while the relay's clock reads earlier. Deleting the tunnel deletes
-- its codes.
CREATE TABLE claim_codes (
    code_hash BLOB PRIMARY KEY NOT NULL,
    tunnel_name TEXT NOT NULL REFERENCES tunnels (name) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX claim_codes_tunnel_name ON claim_codes (tunnel_name);
