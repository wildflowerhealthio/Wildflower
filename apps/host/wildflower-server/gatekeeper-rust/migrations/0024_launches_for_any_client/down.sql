-- Reverse of up.sql: `client_id` is NOT NULL again and the CHECK goes. Launches
-- for any client have no client to keep, so they are not copied back; they
-- live five minutes anyway. Rebuilt for the same reason as up.sql.

CREATE TABLE launch_contexts_new (
    nonce TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    patient TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
) STRICT;

INSERT INTO launch_contexts_new (nonce, client_id, patient, created_at, expires_at, consumed_at)
SELECT nonce, client_id, patient, created_at, expires_at, consumed_at
  FROM launch_contexts
 WHERE client_id IS NOT NULL;

DROP TABLE launch_contexts;

ALTER TABLE launch_contexts_new RENAME TO launch_contexts;
