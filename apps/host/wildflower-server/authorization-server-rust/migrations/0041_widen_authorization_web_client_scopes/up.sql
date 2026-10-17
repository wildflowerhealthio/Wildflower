-- Widen Wildflower Authorization's client (`0031`) to the browser sessions it
-- now lists and revokes. Its `allowed_scopes` stays exactly what the app asks
-- for (`AUTHORIZATION_SCOPE` in `apps/authorization/authorization-web/src/config.ts`;
-- `db/clients.rs` reads that file and pins this row to it):
--
--   wildflower/Grant.rd           list the grants, revoke one
--   wildflower/Client.ru          list the trusted apps, disable or enable one
--   wildflower/Token.d            revoke every token a revoked grant's client holds
--   wildflower/BrowserSession.rd  list the signed-in browsers, revoke one
--
-- ISSUED GRANTS ARE LEFT ALONE. The app's standing grant keeps the scopes the
-- Owner approved; its next sign-in asks for the wider set, which the consent
-- prompt shows the Owner to approve.
--
-- IDEMPOTENT. The `UPDATE` only fires while the row still holds the exact set
-- `0031` wrote, so a row whose scopes were deliberately changed since is left
-- alone, as in `0032`.
UPDATE clients
   SET allowed_scopes = '["openid","wildflower/Grant.rd","wildflower/Client.ru","wildflower/Token.d","wildflower/BrowserSession.rd"]'
 WHERE client_id = '7277e898bee8ac81ea44788236e619a5'
   AND allowed_scopes = '["openid","wildflower/Grant.rd","wildflower/Client.ru","wildflower/Token.d"]';
