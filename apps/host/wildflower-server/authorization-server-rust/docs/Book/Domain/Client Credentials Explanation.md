# Client Credentials

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/client_credentials.rs}}

An app that can keep a secret authenticates at `/oauth/token` by presenting its `client_id` and that secret; one that can't presents its `client_id` alone. This page is the pair as the domain sees it, before anything checks it. The [authenticated-client proof](<../Authority/Authenticated Client Explanation.md>) checks it against the app's [client](<Client Explanation.md>) row, which stores only a hash of the secret.

The secret is the one piece of client material the server ever holds in plaintext, and only for the length of one request. It gets the same two habits as a [signing key's](<Signing Key Explanation.md>) private parts: scrubbed when dropped, and never printed.

## `domain::client_credentials`

### `ClientCredentials`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client_credentials.rs ClientCredentials}}

#### `Debug`

Only whether a secret was presented shows, never its value.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client_credentials.rs ClientCredentials::fmt tests="tests::debug_redacts_client_secret tests::debug_shows_absent_client_secret_as_none"}}
