# Tokens

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/tokens.rs}}

The Owner can revoke an issued token directly: one token by its `jti`, or every token of a subject at once. Both go to the host's revocation store, which the token verifier asks last about every [access token](<../../Domain/Access Token Explanation.md>), and which a refresh asks about its family's subject too. The capability touches no grant store, only the [`Revocation`](<../../Assembly/Ports and Adapters Explanation.md>) port, so it isn't generic over the store.

The route takes exactly one of the two modes per request. It refuses a body naming neither, both, or a `jti` without its `expiresAt`, and an `expiresAt` already past, since that token is expired anyway.

## `domain::capabilities::access::tokens`

### `token_revoker_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/tokens.rs token_revoker_scopes}}

### `TokenRevoker`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/tokens.rs TokenRevoker}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/tokens.rs TokenRevoker::new}}

#### `revoke_jti`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/tokens.rs TokenRevoker::revoke_jti}}

#### `revoke_subject`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/tokens.rs TokenRevoker::revoke_subject}}
