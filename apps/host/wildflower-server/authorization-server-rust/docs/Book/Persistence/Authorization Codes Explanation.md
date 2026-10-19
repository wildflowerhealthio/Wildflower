# Authorization Codes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs}}

An [authorization code](<../Domain/Authorization Code Explanation.md>) lives in the `authorization_codes` table from the moment an approval issues it until the app redeems it at `/oauth/token`, a minute at most. A row is one {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_code.rs IssuedAuthorizationCode}}: the code itself as the primary key, and everything it is bound to (the request, the app, the redirect URI, the PKCE challenge, the granted scopes, the patient, the browser session, the issue and expiry instants).

Two rules live in the schema and in one statement:

- **One code per request.** A unique index on `request_id` makes a second code for the same request a hard error, so the status read below always finds at most one.
- **A code is redeemed once.** Redemption deletes the row and returns it in the same statement, so of two redemptions only one gets it.

The four methods are the `AuthorizationCodesTx` port on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantTx}}.

## Test fixtures

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs tests::arb_authorization_code}}

Any issued code: random values for every column, a 43-character challenge, any timestamps.

## `issue_authorization_code`

Recording a code an approval has just minted: a plain insert of the whole row. Port: [`issue_authorization_code`](<../Grant Store/Authorization Codes Explanation.md#issue_authorization_code>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs SqliteGrantTx::issue_authorization_code}}

A second code for a request that already has one fails on the `request_id` index.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs tests::issue_and_fetch_round_trip}}

Any code, issued and read back by its request, comes back equal to what went in.

## `authorization_code_by_request_id`

The code issued for a request, without spending it. When a browser polls the status of a request that has been approved, {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs AuthorizationStatusReader::status}} reads the code here to build the redirect back to the app. Port: [`authorization_code_by_request_id`](<../Grant Store/Authorization Codes Explanation.md#authorization_code_by_request_id>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs SqliteGrantTx::authorization_code_by_request_id}}

Once the app has redeemed the code, the row is gone and this finds nothing.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs tests::corrupt_redirect_uri_is_a_typed_read_error}}

A stored redirect URI that no longer parses as a URL fails the read with an error, rather than panicking or decoding to some other URL.

## `redeem_authorization_code`

The app trading its code at `/oauth/token`. **Single use rests on this one statement**: `DELETE … RETURNING` removes the row and hands it back together. It runs inside the write scope's `BEGIN IMMEDIATE`, so two redemptions of one code run one after the other; the first gets the row, the second finds nothing, exactly as for a code that was never issued (RFC 6749 §10.5). Port: [`redeem_authorization_code`](<../Grant Store/Authorization Codes Explanation.md#redeem_authorization_code>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs SqliteGrantTx::redeem_authorization_code}}

The row is gone whatever the redemption decides next: a code presented by the wrong app, late, or with the wrong verifier is already spent. What a miss sets off (ending the refresh families an earlier redemption started) is the domain's: [Redeemed once](<../Domain/Authorization Code Explanation.md#redeemed-once>).

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs tests::redeem_returns_the_row_exactly_once}}

The first redemption returns the issued row unchanged; the second returns nothing.

## `delete_authorization_codes_expired_before`

The retention sweep's share of this table: delete every code whose `expires_at` is before the cutoff, and return how many went. Redemption already deletes the codes that were used, so only abandoned ones reach here. The cutoff is the sweep's ([`purge_expired`](<../Domain/Retention Explanation.md#purge_expired>), with [`AUTHORIZATION_RETENTION`](<../Domain/Retention Explanation.md#authorization_retention>)), not the current time. Port: [`delete_authorization_codes_expired_before`](<../Grant Store/Authorization Codes Explanation.md#delete_authorization_codes_expired_before>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs SqliteGrantTx::delete_authorization_codes_expired_before}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs tests::delete_expired_codes_respects_the_cutoff}}

With the cutoff a week back, a code that expired eight days ago goes; one that expired six days ago and one not yet expired stay.
