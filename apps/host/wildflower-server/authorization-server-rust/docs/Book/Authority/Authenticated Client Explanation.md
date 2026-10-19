# Authenticated Client

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs}}

An app's back end calls the server on its own behalf: it redeems a code or a refresh token at `/oauth/token`, or starts a device pairing at `/oauth/device_authorization`. Before it may, **the app must be one the server knows, still enabled, and, if it keeps a secret, it must present that secret**. An **authenticated client** is the proof that it did. Every operation an app does on its own behalf takes one, so no flow can act for an app whose secret was never checked.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient}}

The proof holds the app's [client](<../Domain/Client Explanation.md>) row privately. A flow asks it only what it needs of the app it acts for: its `client_id` and `name`, and the two registration questions below.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient::client_id AuthenticatedClient::name}}

## `ClientAuthenticationError`

The ways authentication fails, each its own variant. The first five are the caller's fault and answer `401 invalid_client`, with a description naming the check (and a `Basic` challenge when the credentials came in the `Authorization` header). The last two are the server's: they are logged and answer `500 server_error` with no detail.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs ClientAuthenticationError keep-docs}}

## Test fixtures

`presented` is what an app sends: its `client_id` and, maybe, a secret.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs tests::presented}}

`confidential` is the shared [`client`](<../Grant Store/Test Fake Explanation.md#client>) fixture made confidential, with the argon2id hash of `secret` stored.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs tests::confidential}}

## `authenticate`

The rule, in order. **An unknown app is refused, then a disabled one, before any secret is looked at.** A public app passes on identity alone: it can't keep a secret, so a secret it sends anyway is ignored. A confidential app must have a stored hash (a confidential row without one is a broken registration, refused rather than let in without a secret), must present a secret, and the secret must match the hash. The comparison runs inside the argon2 verifier, in constant time.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient::authenticate}}

The capability that runs it, in a read scope, is the [Client Authenticator](<../Capabilities/OAuth/Client Authenticator Explanation.md>).

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs tests::a_public_client_authenticates_on_identity_alone}}

A public app authenticates with no secret and with a stray one, and the proof answers with its id and name.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs tests::unknown_and_disabled_clients_are_refused}}

An unknown id is `UnknownClient`; a disabled app is `Disabled` even when it presents its right secret.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs tests::a_confidential_client_needs_the_matching_secret}}

No secret is `SecretRequired`, a wrong one `SecretMismatch`, a row with no hash `SecretNotConfigured`; the right secret authenticates.

Exercised end to end by [`token_exchange_wrong_basic_secret_returns_401_with_basic_challenge`](<../Integration Tests/Client Auth Explanation.md#token_exchange_wrong_basic_secret_returns_401_with_basic_challenge>), [`token_exchange_body_secret_failure_has_no_basic_challenge`](<../Integration Tests/Client Auth Explanation.md#token_exchange_body_secret_failure_has_no_basic_challenge>) and [`device_authorization_wrong_basic_secret_returns_401_with_basic_challenge`](<../Integration Tests/Client Auth Explanation.md#device_authorization_wrong_basic_secret_returns_401_with_basic_challenge>).

## `allows_grant_type`

**An app may redeem only the grant types its registration lists.** The token exchange asks this of the proof before it opens a scope to redeem anything, and refuses with `unauthorized_client`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient::allows_grant_type}}

No unit test of its own; [`the_proof_answers_for_its_registration`](#allows_scopes) covers it with `allows_scopes`. Exercised end to end by [`token_endpoint_rejects_grant_outside_client_allow_list`](<../Integration Tests/Device Code Explanation.md#token_endpoint_rejects_grant_outside_client_allow_list>).

## `allows_scopes`

**An app may ask for any scope one of its registered scopes covers**, by coverage as the client's own [`allows_scopes`](<../Domain/Client Explanation.md#allows_scopes>) judges it. The device flow asks this before it parks a request.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient::allows_scopes}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs tests::the_proof_answers_for_its_registration}}

An app registered for the device grant alone and for `patient/*.rs` is allowed the device grant and not refresh, and `patient/Observation.r` but not `patient/Observation.c`.
