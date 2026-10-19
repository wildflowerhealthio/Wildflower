# Client Token Revoker

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs}}

`POST /oauth/revoke` (RFC 7009) is how an app gives up a token it holds, when its user signs out of it, say. The app [authenticates](<Client Authenticator Explanation.md#authenticate>) first, as it does at `/oauth/token`. **An app can only revoke its own tokens.** A refresh token ends its whole [family](<../../Domain/Refresh Token Explanation.md>); an access token is denylisted by its `jti` until it expires.

**Anything else is left alone and answered alike**: a token the server doesn't know, one already dead, one minted by another server, one issued to another app. The answer is the same empty success every time, so an app learns nothing about a token that isn't its own.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs ClientTokenRevoker}}

It holds the store, the revocation port that writes the `jti` denylist, and the server's origin, the one `iss` and `aud` a token this server minted carries. `new` builds it from those handles, lifted from the state.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs ClientTokenRevoker::new}}

## Test fixtures

`revoker` builds the capability over a fake store holding an active signing key, writing to a real in-memory revocation store, which it returns too. `authenticated` authenticates a public client by id.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::revoker}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::authenticated}}

`plant_family` stores a 30-day family for a client whose one live token is the given plaintext, and `family_expires_at` reads back when that family ends.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::plant_family}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::family_expires_at}}

`access_token` mints a five-minute access token for a client, signed with the store's key and naming the given issuer as `iss` and `aud`. `jti_is_denylisted` asks the revocation store about the token's `jti`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::access_token}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::jti_is_denylisted}}

## `revoke`

**The token says what it is**, so the request's `token_type_hint` is never read.

1. In one **write** scope, the presented token is looked up as a refresh token, by its storage hash. If it is one, its family is ended there, and the revoke is done.
2. If it isn't, the same scope reads every signing key, and closes.
3. **Outside the scope**, the token is tried as an access token, verified against those keys with the server's origin as issuer and audience. One this server minted for this app is denylisted through the revocation port, which writes to its own store.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs ClientTokenRevoker::revoke}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs PresentedToken}}

**Nothing about the token itself is an error.** Only a store that can't be read or written is.

### Ending a refresh family

Any generation of the family will do: it is the family that ends. **Another app's family is left alone**, logged and answered alike. A family already over keeps the instant it ended at, so revoking it again doesn't move its end. Otherwise the family is expired now. Ending the family touches no access token already minted from it; those live out their own lifetimes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs end_refresh_family}}

### Denylisting an access token

**A token that doesn't verify can't be used anyway, so there is nothing to revoke**: a forged one, an expired one, another server's. A failure to verify for the server's own reasons (no signing key, a key that can't be read) is an error instead. A verified token issued to another app is left alone and logged. One without a `jti` or expiry can't be denylisted on its own, and every token this server mints carries both. Otherwise its `jti` is denylisted until the token's own expiry, tagged with the reason `client revocation`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs ClientTokenRevoker::denylist_access_token}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs CLIENT_REVOCATION_REASON}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::a_refresh_token_ends_its_family_only_for_its_own_client}}

Another app presenting the family's token leaves it running. Its own app ends it at that instant. Revoking it again a minute later leaves the end where it was.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::an_access_token_is_denylisted_only_for_its_own_client}}

Another app presenting the token doesn't denylist it; its own app does. A token naming another issuer isn't denylisted, and a string that is no token at all is answered with success.

Exercised end to end by the [Token Revocation](<../../Integration Tests/Token Revocation Explanation.md>) tests: [`an_app_revokes_its_own_refresh_token`](<../../Integration Tests/Token Revocation Explanation.md#an_app_revokes_its_own_refresh_token>), [`an_app_revokes_its_own_access_token`](<../../Integration Tests/Token Revocation Explanation.md#an_app_revokes_its_own_access_token>), [`another_client_s_tokens_are_answered_alike_and_left_alone`](<../../Integration Tests/Token Revocation Explanation.md#another_client_s_tokens_are_answered_alike_and_left_alone>), [`unknown_and_dead_tokens_get_200`](<../../Integration Tests/Token Revocation Explanation.md#unknown_and_dead_tokens_get_200>) and [`a_wrong_token_type_hint_still_revokes`](<../../Integration Tests/Token Revocation Explanation.md#a_wrong_token_type_hint_still_revokes>).
