-- Whether the browser that made an authorization-code request carried the
-- Owner browser session when `/oauth/authorize` parked it. That browser is
-- sent to the consent card itself, so the host can tell a request the Owner
-- is already looking at from one made elsewhere. Existing rows, and every
-- device-code request, are 0.
ALTER TABLE authorization_requests ADD COLUMN requested_by_owner_browser INTEGER NOT NULL DEFAULT 0;
