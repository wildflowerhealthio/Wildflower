-- A request is never stored as expired: expiry is read from `expires_at`.
-- What the `expired` status stood for splits two ways. An approved device
-- request or browser pairing that its poll redeemed carries its approval
-- (`granted_scopes`) and becomes `claimed`. Every other `expired` row is a
-- pending request `0042` ended for want of a browser session, which no flow
-- reaches; it is deleted.
UPDATE authorization_requests
   SET status = 'claimed'
 WHERE status = 'expired'
   AND granted_scopes IS NOT NULL;

DELETE FROM authorization_requests
 WHERE status = 'expired';

-- A code request lacking any of `sid`, `redirect_uri`, `code_challenge` or
-- `client_state` was made before the browser-session flow (`0036`); `0042`
-- ended only the pending ones, so approved and denied ones remain. No flow
-- reaches them, and a request without them can't be read back; they are
-- deleted.
DELETE FROM authorization_requests
 WHERE grant_type = 'authorization_code'
   AND (sid IS NULL
        OR redirect_uri IS NULL
        OR code_challenge IS NULL
        OR client_state IS NULL);

-- PKCE is S256 only (`plain` is refused at `/oauth/authorize`), so the
-- method column says nothing the challenge doesn't.
ALTER TABLE authorization_requests DROP COLUMN code_challenge_method;
