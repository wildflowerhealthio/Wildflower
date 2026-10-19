-- Whether the browser that made an authorization-code request said to go on
-- although its browser session holds less than the app asked for. A request
-- whose session falls short of it parks with 0 and waits on that browser's
-- limited page: the Owner isn't asked about it, nothing decides it and no code
-- is issued for it until the browser presses Continue, which sets 1. Existing
-- rows, every device request and browser pairing, every request whose session
-- holds all it asks for, and every request from a session that already went
-- on for the same client are 1.
ALTER TABLE authorization_requests ADD COLUMN session_shortfall_acknowledged INTEGER NOT NULL DEFAULT 1;

-- The apps each browser session has gone on past its limited page for: one
-- row per (`sid`, `client_id`), written when that browser presses Continue.
-- A later request from the same session for the same client skips the page,
-- whatever the session then lacks of it. Cancel writes nothing. A soft
-- reference to `browser_sessions(sid)`, like `authorization_requests.sid`:
-- the retention sweep's session prune deletes a session's rows with it.
CREATE TABLE session_shortfall_acknowledgements (
    sid TEXT NOT NULL,
    client_id TEXT NOT NULL,
    PRIMARY KEY (sid, client_id)
) STRICT;
