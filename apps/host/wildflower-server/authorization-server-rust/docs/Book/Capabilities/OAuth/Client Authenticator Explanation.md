# Client Authenticator

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_authenticator.rs}}

An app that calls `/oauth/token`, `/oauth/device_authorization` or `/oauth/revoke` speaks for itself, not for a person. Before it may do anything there, the server checks it is who it says it is. **The client authenticator is the one door to that check.** It turns the credentials an app presented into the [`AuthenticatedClient`](<../../Authority/Authenticated Client Explanation.md#authenticate>) proof, and every client-gated capability takes that proof, never a bare `client_id`. The token-style request extractor, which all three endpoints use, goes through it before their handlers run.

The authenticator holds the store and nothing else, so a handler holding one can do nothing but authenticate.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_authenticator.rs ClientAuthenticator}}

`new` wraps a store handle lifted from the state.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_authenticator.rs ClientAuthenticator::new}}

## `authenticate`

The app presents a `client_id` and, if it is confidential, a secret. The authenticator opens a **read** scope and runs the proof's own constructor inside it. The rule lives there, not here: an unknown or disabled client is refused, a public client passes on its identity alone, and a confidential one must present the secret its stored hash matches. Nothing is written.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_authenticator.rs ClientAuthenticator::authenticate}}

The outcome is the proof, or a `ClientAuthenticationError` naming the failed check. The extractor answers the caller's failures as `401 invalid_client` and a store or secret-verifier failure as `500 server_error`.

No unit test of its own; the proof's constructor has them, under [`authenticate`](<../../Authority/Authenticated Client Explanation.md#authenticate>).

Exercised end to end by the [Client Auth](<../../Integration Tests/Client Auth Explanation.md>) tests, for example [`token_exchange_wrong_basic_secret_returns_401_with_basic_challenge`](<../../Integration Tests/Client Auth Explanation.md#token_exchange_wrong_basic_secret_returns_401_with_basic_challenge>), and by [`device_authorization_unknown_client_returns_401`](<../../Integration Tests/OAuth Endpoints Explanation.md#device_authorization_unknown_client_returns_401>) and [`an_unknown_client_is_invalid_client`](<../../Integration Tests/Token Revocation Explanation.md#an_unknown_client_is_invalid_client>).
