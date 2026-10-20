# Client Authenticator

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_authenticator.rs}}

An app that calls `/oauth/token`, `/oauth/device_authorization` or `/oauth/revoke` speaks for itself, not for a person. Before it may do anything there, the server checks it is who it says it is, from the [credentials](<../../Domain/Client Credentials Explanation.md>) it presents. **The client authenticator is the one door to that check.** It turns those credentials into the [`AuthenticatedClient`](<../../Authority/Authenticated Client Explanation.md>) proof, and every client-gated capability takes that proof, never a bare `client_id`. The token-style request extractor, which all three endpoints use, goes through it before their handlers run.

The authenticator holds the store and nothing else, so a handler holding one can do nothing but authenticate. The rule itself lives on the proof's constructor, which has the tests.

## `domain::capabilities::oauth::client_authenticator`

### `ClientAuthenticator`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_authenticator.rs ClientAuthenticator}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_authenticator.rs ClientAuthenticator::new}}

#### `authenticate`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_authenticator.rs ClientAuthenticator::authenticate}}
