-- Browser sessions: one row per browser the server has signed in, keyed by
-- the `sid` every token, code and refresh family minted under it records.
-- `kind` is `owner` (a same-device sign-in) or `approved` (a browser the
-- Owner approved). `name` is the name an approved browser was given, NULL for
-- an Owner browser; `scopes` is the session's grant as compact JSON TEXT.
-- `revoked_at` is set when the session is revoked, which ends everything it
-- minted; `last_seen_at` is set when the row is created. Timestamps are the
-- diesel chrono text encoding (`%F %T%.f%:z`).
CREATE TABLE browser_sessions (
    sid TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('owner', 'approved')),
    name TEXT,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_seen_at TEXT NOT NULL
) STRICT;

-- The browser session each request, code and refresh family was made under,
-- NULL when there was none (a device-flow request, a browser without a
-- session). A soft reference, like `refresh_token_families.grant_id`: the
-- retention sweep prunes an ended session once no family names it, so no
-- foreign key.
ALTER TABLE authorization_requests ADD COLUMN sid TEXT;
ALTER TABLE authorization_codes ADD COLUMN sid TEXT;
ALTER TABLE refresh_token_families ADD COLUMN sid TEXT;

-- The retention sweep's "does a family still name this session?" probe.
CREATE INDEX refresh_token_families_sid_idx ON refresh_token_families(sid);
