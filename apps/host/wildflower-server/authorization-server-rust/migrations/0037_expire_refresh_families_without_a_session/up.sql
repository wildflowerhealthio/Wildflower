-- End every refresh-token family issued before browser sessions existed. None
-- of them names the session it was minted under, so revoking a session could
-- never reach them; every app signs in again once. Same expire-and-stamp
-- semantics as `expire_refresh_token_family`: a live family's deadline is
-- pulled back to now and its live token stamped consumed, and the rows stay
-- for the retention sweep. A family already past its deadline is left as it
-- is, so its retention window doesn't restart.
UPDATE refresh_tokens
   SET consumed_at = strftime('%Y-%m-%d %H:%M:%f+00:00', 'now')
 WHERE consumed_at IS NULL
   AND family_id IN (SELECT family_id FROM refresh_token_families
                      WHERE expires_at > strftime('%Y-%m-%d %H:%M:%f+00:00', 'now'));
UPDATE refresh_token_families
   SET expires_at = strftime('%Y-%m-%d %H:%M:%f+00:00', 'now')
 WHERE expires_at > strftime('%Y-%m-%d %H:%M:%f+00:00', 'now');
