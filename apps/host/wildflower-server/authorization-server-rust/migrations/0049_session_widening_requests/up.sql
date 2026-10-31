-- Session widenings: a paired browser asking the Owner, from its limited
-- page, for its browser session to hold more. Keyed by id, like a code
-- request, since the browser asks on the server's own origin with its
-- session cookie and needs no `user_code`; claimed once by that page's poll,
-- like a pairing, which takes the wider session token. Each row names the
-- session it widens (`sid`, a soft reference like
-- `code_authorization_requests.sid`), the app whose request the session fell
-- short of (`client_id`), the session's name when it asked, and the scopes it
-- lacked. `granted_scopes` is set exactly while the widening carries the
-- Owner's approval.
CREATE TABLE session_widening_requests (
    id TEXT PRIMARY KEY NOT NULL,
    sid TEXT NOT NULL,
    client_id TEXT NOT NULL,
    browser_name TEXT NOT NULL,
    requested_scopes TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'claimed')),
    granted_scopes TEXT,
    CHECK ((status IN ('approved', 'claimed')) = (granted_scopes IS NOT NULL))
) STRICT;
