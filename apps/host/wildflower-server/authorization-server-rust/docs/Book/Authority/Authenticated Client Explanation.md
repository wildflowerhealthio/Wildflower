# Authenticated Client

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs}}

An app's back end calls the server on its own behalf: it redeems a code or a refresh token at `/oauth/token`, or starts a device pairing at `/oauth/device_authorization`. Before it may, **the app must be one the server knows, still enabled, and, if it keeps a secret, it must present that secret**. An **authenticated client** is the proof that it did. Every operation an app does on its own behalf takes one, so no flow can act for an app whose secret was never checked.

What the app presents is its [client credentials](<../Domain/Client Credentials Explanation.md>); what they are checked against is its [client](<../Domain/Client Explanation.md#item-Client>) row, which stores only a hash of the secret. The capability that runs the check, in a read scope, is the [Client Authenticator](<../Capabilities/OAuth/Client Authenticator Explanation.md>).

## `domain::authority::authenticated_client`

The tests present credentials and register a confidential app with the [authenticated-client fixtures](<Test Fixtures Explanation.md#authenticated-client>), over the shared [client fixture](<../Domain/Test Fixtures Explanation.md#client>).

### `AuthenticatedClient`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient}}

#### `authenticate`

**An unknown app is refused, then a disabled one, before any secret is looked at.** A secret a public app sends anyway is ignored: it can't keep one, so it has nothing to prove with it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient::authenticate tests="tests::a_public_client_authenticates_on_identity_alone tests::unknown_and_disabled_clients_are_refused tests::a_confidential_client_needs_the_matching_secret"}}

End to end, the [Client Auth](<../Integration Tests/Client Auth Explanation.md>) tests hold the wire answers: a wrong secret sent in the `Authorization` header gets a `Basic` challenge, and one sent in the body doesn't.

#### `client_id` and `name`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient::client_id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient::name}}

#### `allows_grant_type` and `allows_scopes`

The token exchange asks `allows_grant_type` before it opens a scope to redeem anything, and refuses with `unauthorized_client`. The device flow asks `allows_scopes` before it parks a request. Both answer for the registration the proof verified, as the [client](<../Domain/Client Explanation.md#item-Client--allows_scopes>) would.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient::allows_grant_type}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient::allows_scopes tests="tests::the_proof_answers_for_its_registration"}}

### `ClientAuthenticationError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs ClientAuthenticationError}}
