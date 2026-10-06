-- Reverse of `up.sql`: the table `0002_tunnel_requests` created. Never run at
-- runtime (the store only ever rolls migrations forward); present because the
-- diesel migration harness expects a `down.sql` per migration.
CREATE TABLE tunnel_requests (
    id             INTEGER PRIMARY KEY,
    received_at    TEXT NOT NULL,
    client_id      TEXT,
    address        TEXT,
    served_host    TEXT,
    method         TEXT NOT NULL,
    path           TEXT NOT NULL,
    status         INTEGER NOT NULL,
    response_bytes INTEGER,
    duration_ms    INTEGER NOT NULL,
    refusal        TEXT CHECK (refusal IN ('missing_token', 'token_rejected', 'revoked'))
) STRICT;

CREATE INDEX tunnel_requests_received_at ON tunnel_requests (received_at);
CREATE INDEX tunnel_requests_client_address ON tunnel_requests (client_id, address);
CREATE INDEX tunnel_requests_verified_caller_id ON tunnel_requests (id)
    WHERE client_id IS NOT NULL;
CREATE INDEX tunnel_requests_unverified_caller_id ON tunnel_requests (id)
    WHERE client_id IS NULL;
