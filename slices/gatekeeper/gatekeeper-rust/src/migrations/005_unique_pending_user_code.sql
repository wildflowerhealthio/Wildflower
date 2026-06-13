-- At most one *pending* request per user_code. The device-flow consent loader
-- (`pending_authorization_request_by_user_code`) reads a single pending row;
-- without this, two concurrently-created pending requests sharing a user_code
-- (a generation collision the pre-insert probe in `generate_unique_user_code`
-- can race) would let the Owner approve an arbitrary one. A *partial* unique
-- index keeps terminal (expired/denied/approved) rows free to share a code
-- while making a second live duplicate a hard error rather than silent
-- ambiguity. The existing non-unique index still backs any-status lookups.
CREATE UNIQUE INDEX authorization_requests_pending_user_code_uidx
    ON authorization_requests(user_code)
    WHERE status = 'pending' AND user_code IS NOT NULL;
