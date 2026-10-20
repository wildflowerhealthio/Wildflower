# Authorization Codes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs}}

An [authorization code](<../Domain/Authorization Code Explanation.md>) lives in the `authorization_codes` table from the moment an approval issues it until the app redeems it at `/oauth/token`, a minute at most. A row is one [`AuthorizationCode`](<../Domain/Authorization Code Explanation.md#item-AuthorizationCode>): the code itself as the primary key, and everything it is bound to, the request, the app, the redirect URI, the PKCE challenge, the granted scopes, the patient, the browser session, the issue and expiry instants.

Two rules live in the schema and in one statement:

- **One code per request.** A unique index on `request_id` makes a second code for the same request a hard error, so the status read always finds at most one.
- **A code is redeemed once.** Redemption deletes the row and returns it in the same statement, so of two redemptions only one gets it.

The tests draw codes from [`arb_authorization_code`](<Test Fixtures Explanation.md#item-tests--arb_authorization_code>).

## `db::authorization_codes`

### `impl AuthorizationCodesTx for SqliteGrantTx`

The port is [`AuthorizationCodesTx`](<../Grant Store/Authorization Codes Explanation.md#item-AuthorizationCodesTx>).

#### `issue_authorization_code`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs SqliteGrantTx::issue_authorization_code tests="tests::issue_and_fetch_round_trip"}}

#### `authorization_code_by_request_id`

When a browser polls the status of a request that has been approved, the [status reader](<../Capabilities/OAuth/Authorization Status Reader Explanation.md>) reads the code here to build the redirect back to the app. Once the app has redeemed the code, the row is gone and this finds nothing.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs SqliteGrantTx::authorization_code_by_request_id tests="tests::corrupt_redirect_uri_is_a_typed_read_error"}}

#### `redeem_authorization_code`

**Single use rests on this one statement.** The row is gone whatever the redemption decides next: a code presented by the wrong app, late, or with the wrong verifier is already spent. What a miss sets off, ending the refresh families an earlier redemption started, is the [redemption proof](<../Authority/Redemption Explanation.md>)'s.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs SqliteGrantTx::redeem_authorization_code tests="tests::redeem_returns_the_row_exactly_once"}}

#### `delete_authorization_codes_expired_before`

The cutoff is the sweep's, [`purge_expired`](<../Domain/Retention Explanation.md#item-purge_expired>) with [`AUTHORIZATION_RETENTION`](<../Domain/Retention Explanation.md#item-AUTHORIZATION_RETENTION>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs SqliteGrantTx::delete_authorization_codes_expired_before tests="tests::delete_expired_codes_respects_the_cutoff"}}
