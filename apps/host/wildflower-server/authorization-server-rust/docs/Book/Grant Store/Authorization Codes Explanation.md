# Authorization Codes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_codes.rs}}

The `authorization_codes` table holds the [authorization codes](<../Domain/Authorization Code Explanation.md>) the server has issued and no app has yet redeemed. A code is issued when the Owner approves a code request, and found again through its request when the waiting browser polls for where to go next. **The rule this table keeps is that a code redeems once**: redeeming reads and deletes it in one statement, so of two apps presenting the same code at once, exactly one gets it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_codes.rs AuthorizationCodesTx}}

## `issue_authorization_code`

Record a freshly minted code: what the Owner approved, for which app, redirect and PKCE challenge, under which browser session, until when. The request approver writes it in the same write scope as the approval.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_codes.rs AuthorizationCodesTx::issue_authorization_code}}

The SQLite side: [`issue_authorization_code`](<../Persistence/Authorization Codes Explanation.md#issue_authorization_code>).

## `authorization_code_by_request_id`

The code issued for this request, or `None`. The browser waiting on an approved request polls its status, and this is how the server builds the redirect that hands the code to the app.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_codes.rs AuthorizationCodesTx::authorization_code_by_request_id}}

The SQLite side: [`authorization_code_by_request_id`](<../Persistence/Authorization Codes Explanation.md#authorization_code_by_request_id>).

## `redeem_authorization_code`

Read the code and delete it in one statement, returning the row **exactly once**: any other redemption of the same code, concurrent or later, gets `None` (RFC 6749 §10.5). The redemption proof treats `None` as a replay and ends every refresh family the code started, then checks everything else about the row it got. See [Redeemed once](<../Domain/Authorization Code Explanation.md#redeemed-once>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_codes.rs AuthorizationCodesTx::redeem_authorization_code}}

The SQLite side: [`redeem_authorization_code`](<../Persistence/Authorization Codes Explanation.md#redeem_authorization_code>).

## `delete_authorization_codes_expired_before`

The retention sweep's step for codes: delete every code whose `expires_at` fell before `cutoff`, and count them. Redemption already deletes a code as it is used, so this reaps only the abandoned ones.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_codes.rs AuthorizationCodesTx::delete_authorization_codes_expired_before}}

The SQLite side: [`delete_authorization_codes_expired_before`](<../Persistence/Authorization Codes Explanation.md#delete_authorization_codes_expired_before>).
