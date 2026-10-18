-- When each browser session was last seen in use: set when the browser signs
-- in, and moved when the server accepts the session's cookie (at most once
-- every five minutes per session) and when a refresh-token family that names
-- the session rotates. A standing session's row is backfilled to its
-- `created_at`. Timestamps are the diesel chrono text encoding
-- (`%F %T%.f%:z`).
--
-- SQLite adds a `NOT NULL` column in place only with a default, and no
-- default is a time a session was seen, so the table is rebuilt with the
-- column. No foreign key or index names `browser_sessions`.
CREATE TABLE browser_sessions_with_last_seen (
    sid TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('owner', 'approved')),
    name TEXT,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_seen_at TEXT NOT NULL
) STRICT;

INSERT INTO browser_sessions_with_last_seen
    (sid, kind, name, scopes, created_at, expires_at, revoked_at, last_seen_at)
SELECT sid, kind, name, scopes, created_at, expires_at, revoked_at, created_at
  FROM browser_sessions;

DROP TABLE browser_sessions;
ALTER TABLE browser_sessions_with_last_seen RENAME TO browser_sessions;
