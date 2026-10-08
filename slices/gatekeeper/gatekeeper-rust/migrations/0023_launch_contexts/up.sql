-- SMART App Launch contexts: one row per `launch` value this server hands out.
-- A launch is minted in-process (the apps launch route, the base's launch)
-- through the gatekeeper's `LaunchContexts` capability, and `/oauth/authorize`
-- consumes it single-use. No other slice reads or writes the table.
--
-- `nonce` is the opaque `launch` value itself (plaintext, like
-- `authorization_codes.code`: it lives five minutes and is good for one
-- authorize). `client_id` is the OAuth client the launch is for; an authorize
-- from any other client is refused. `patient` is the patient the launch binds,
-- when it binds one; a consent approval must then name the same patient.
-- `consumed_at` is set by the one authorize that uses the launch: the consume is
-- a conditional `UPDATE … WHERE consumed_at IS NULL`, so two racing authorizes
-- can't both win. Expired rows are deleted when the next launch is minted.
CREATE TABLE launch_contexts (
    nonce TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    patient TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
) STRICT;

-- The launch context an authorization-code request was started with, carried
-- onto the parked request: the consumed `launch` value and the patient it
-- bound. Both NULL for a plain OAuth request (no `launch`). The patient is
-- copied rather than joined, so the request keeps its binding after the
-- context row is pruned.
ALTER TABLE authorization_requests ADD COLUMN launch TEXT;
ALTER TABLE authorization_requests ADD COLUMN launch_patient TEXT;
