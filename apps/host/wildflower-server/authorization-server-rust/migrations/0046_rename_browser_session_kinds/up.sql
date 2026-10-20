-- Name each browser session's `kind` after how the browser signed in:
-- `same_device` for a same-device sign-in on the server's own device, and
-- `paired` for a browser that paired at `/oauth/pair` with a code the Owner
-- approved. Rows stored as `owner` become `same_device`, and `approved`
-- becomes `paired`; every other column is copied as it is.
--
-- The `kind` CHECK names the allowed strings, and SQLite can't alter a CHECK
-- in place, so the table is rebuilt. No foreign key or index names
-- `browser_sessions`.
CREATE TABLE browser_sessions_with_new_kinds (
    sid TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('same_device', 'paired')),
    name TEXT,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_seen_at TEXT NOT NULL
) STRICT;

INSERT INTO browser_sessions_with_new_kinds
    (sid, kind, name, scopes, created_at, expires_at, revoked_at, last_seen_at)
SELECT sid,
       CASE kind WHEN 'owner' THEN 'same_device' WHEN 'approved' THEN 'paired' END,
       name, scopes, created_at, expires_at, revoked_at, last_seen_at
  FROM browser_sessions;

DROP TABLE browser_sessions;
ALTER TABLE browser_sessions_with_new_kinds RENAME TO browser_sessions;
