-- The request log: one row per request the trusted front relayed to the
-- server, written in batches by the request-log writer off the request path.
-- `path` is already reduced to its route (no ids, no query string), so the log
-- holds no record identifiers. `client_id` is the verified caller, NULL for a
-- request no bearer gate verified (ungated, or refused with a `refusal`).
--
-- Two row caps bound it, one per class: rows with a verified caller and rows
-- without. Each class is trimmed by an id-range delete through its own partial
-- index, so a flood of refused requests only evicts other refused requests.
-- `received_at` is indexed for the 30-day retention sweep, and
-- (client_id, address) for the callers summary, which groups on it.
CREATE TABLE logged_requests (
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

CREATE INDEX logged_requests_received_at ON logged_requests (received_at);
CREATE INDEX logged_requests_client_address ON logged_requests (client_id, address);
CREATE INDEX logged_requests_verified_caller_id ON logged_requests (id)
    WHERE client_id IS NOT NULL;
CREATE INDEX logged_requests_unverified_caller_id ON logged_requests (id)
    WHERE client_id IS NULL;
