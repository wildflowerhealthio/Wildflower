# Authorization Codes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_codes.rs}}

The `authorization_codes` table holds the [authorization codes](<../Domain/Authorization Code Explanation.md>) the server has issued and no app has yet redeemed. The [request approver](<../Writers/Request Approver Explanation.md>) issues a code in the same write scope as the approval, and the browser waiting on the request finds it again by the request's id when it polls for where to go next. **The rule this table keeps is that a code redeems once**: redeeming reads and deletes it in one statement, so of two apps presenting the same code at once, exactly one gets it. The [redemption proof](<../Authority/Redemption Explanation.md>) treats a miss as a replay and ends every refresh family the code started.

## `domain::grant_store::authorization_codes`

### `AuthorizationCodesTx`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_codes.rs AuthorizationCodesTx}}
