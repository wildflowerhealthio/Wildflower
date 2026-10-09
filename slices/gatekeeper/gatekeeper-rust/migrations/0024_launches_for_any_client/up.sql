-- Launches for any client: a launch context may name no OAuth client, so
-- whichever client presents its `launch` value first consumes it. The base
-- mints these for a server's launcher, which can be any app. A launch that
-- names a client still refuses every other client.
--
-- `client_id` becomes nullable: NULL means the launch is for any client. A
-- launch that binds a patient must name its client too (the CHECK), so a
-- patient binding never reaches an app nobody chose.
--
-- WHY A REBUILD. SQLite can't drop a column's NOT NULL in place, so the table
-- is recreated and its rows copied across. Nothing references
-- `launch_contexts`, so the copy-drop-rename cascades nowhere.

CREATE TABLE launch_contexts_new (
    nonce TEXT PRIMARY KEY NOT NULL,
    client_id TEXT,
    patient TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    CHECK (patient IS NULL OR client_id IS NOT NULL)
) STRICT;

INSERT INTO launch_contexts_new (nonce, client_id, patient, created_at, expires_at, consumed_at)
SELECT nonce, client_id, patient, created_at, expires_at, consumed_at FROM launch_contexts;

DROP TABLE launch_contexts;

ALTER TABLE launch_contexts_new RENAME TO launch_contexts;
