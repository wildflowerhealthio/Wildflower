# Client Token Revoker

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs}}

`POST /oauth/revoke` (RFC 7009) is how an app gives up a token it holds, when its user signs out of it, say. The app [authenticates](<Client Authenticator Explanation.md>) first, as it does at `/oauth/token`. **An app can only revoke its own tokens.** A refresh token ends its whole [family](<../../Domain/Refresh Token Explanation.md>); an [access token](<../../Domain/Access Token Explanation.md>) is denylisted by its `jti` until it expires, in the host's revocation store, through the [`Revocation`](<../../Assembly/Ports and Adapters Explanation.md>) port.

**Anything else is left alone and answered alike**: a token the server doesn't know, one already dead, one minted by another server, one issued to another app. The answer is the same empty success every time, so an app learns nothing about a token that isn't its own. Ending a family touches no access token already minted from it; those live out their own fifteen minutes.

The tests revoke into a real in-memory revocation store, over the [revoker fixtures](<../Test Fixtures Explanation.md#client-token-revoker>).

## `domain::capabilities::oauth::client_token_revoker`

### `CLIENT_REVOCATION_REASON`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs CLIENT_REVOCATION_REASON}}

### `ClientTokenRevoker`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs ClientTokenRevoker}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs ClientTokenRevoker::new}}

#### `revoke`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs ClientTokenRevoker::revoke tests="tests::a_refresh_token_ends_its_family_only_for_its_own_client tests::an_access_token_is_denylisted_only_for_its_own_client"}}

#### `denylist_access_token`

The check is [`verify_access_token`](<../../Domain/Access Token Explanation.md#item-verify_access_token>), with the server's origin as issuer and audience.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs ClientTokenRevoker::denylist_access_token}}

### `PresentedToken`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs PresentedToken}}

### `end_refresh_family`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs end_refresh_family}}
