-- Reverse of up.sql: rebuild the table with the `owner` / `approved` CHECK and
-- map each row's `kind` back.
CREATE TABLE browser_sessions_with_old_kinds (
    sid TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('owner', 'approved')),
    name TEXT,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_seen_at TEXT NOT NULL
) STRICT;

INSERT INTO browser_sessions_with_old_kinds
    (sid, kind, name, scopes, created_at, expires_at, revoked_at, last_seen_at)
SELECT sid,
       CASE kind WHEN 'same_device' THEN 'owner' WHEN 'paired' THEN 'approved' END,
       name, scopes, created_at, expires_at, revoked_at, last_seen_at
  FROM browser_sessions;

DROP TABLE browser_sessions;
ALTER TABLE browser_sessions_with_old_kinds RENAME TO browser_sessions;
