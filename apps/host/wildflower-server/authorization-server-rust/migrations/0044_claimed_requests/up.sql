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

-- PKCE is S256 only (`plain` is refused at `/oauth/authorize`), so the
-- method column says nothing the challenge doesn't.
ALTER TABLE authorization_requests DROP COLUMN code_challenge_method;
