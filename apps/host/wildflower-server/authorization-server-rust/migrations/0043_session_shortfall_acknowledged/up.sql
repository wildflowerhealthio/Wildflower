-- Whether the browser that made an authorization-code request said to go on
-- although its browser session holds less than the app asked for. A request
-- whose session falls short of it parks with 0 and waits on that browser's
-- limited page: the Owner isn't asked about it, nothing decides it and no code
-- is issued for it until the browser presses Continue, which sets 1. Existing
-- rows, every device request and browser pairing, and every request whose
-- session holds all it asks for are 1.
ALTER TABLE authorization_requests ADD COLUMN session_shortfall_acknowledged INTEGER NOT NULL DEFAULT 1;
