# Token Revocation

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs}}

`POST /oauth/revoke` (RFC 7009) is how an app gives up a token it holds, say when its user signs out of it. The app authenticates as it does at `/oauth/token`: a public client by its `client_id`, a confidential one with its secret too. Then:

- **A refresh token ends its whole family**, whichever generation is presented.
- **An access token is denylisted by its `jti`** until it expires, if this server minted it for that client.
- **Anything else is answered alike and left alone**: a token the server never issued, one already dead, another server's, and another client's. The answer is always `200` with an empty body, so an app learns nothing about a token that isn't its own.

The server tells the token's type from the token itself and never reads `token_type_hint`. The revoker is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs ClientTokenRevoker::revoke}}.

The file's last two tests hold refresh redemption to the client's revocation epoch, which the [Revocation](<Revocation Explanation.md>) page introduces: a family begun before its client's epoch no longer refreshes. Read the [Refresh Token](<../Domain/Refresh Token Explanation.md>) and [Token](<../Domain/Token Explanation.md>) pages first.

## Helpers

Two public clients, each allowed `read` and `offline_access`: the app that revokes, and another whose tokens it must not touch.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs APP_CLIENT_ID}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs OTHER_CLIENT_ID}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs seed_public_clients}}

A form post, a revoke and a refresh as a public client, and the two answers the tests expect: the RFC 7009 success, and a refresh refused `invalid_grant`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs post_form_body}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs revoke}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs refresh}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs assert_revocation_answered}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs assert_refresh_revoked}}

## `an_app_revokes_its_own_refresh_token`

**An app can end its own refresh family.** The app refreshes once, then revokes the successor it was handed. The successor no longer refreshes.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs an_app_revokes_its_own_refresh_token}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#refreshtokenfamily>).

## `an_app_revokes_its_own_access_token`

**An app can revoke its own access token.** The token is live (the gate answers `403`, since it reaches no `/authorization` scope). After the revoke its `jti` is denylisted, and the gate rejects it outright: `401`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs an_app_revokes_its_own_access_token}}

Relies on [`verify_jwt`](<../Domain/Token Explanation.md#verify_jwt>) and [`AccessTokenClaims`](<../Domain/Token Explanation.md#accesstokenclaims>).

## `another_client_s_tokens_are_answered_alike_and_left_alone`

**An app can't revoke another client's tokens, and can't tell it tried.** Both the other client's refresh token and its access token get the same `200`. The other client still refreshes, and its access token is not denylisted.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs another_client_s_tokens_are_answered_alike_and_left_alone}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#refreshtokenfamily>).

## `unknown_and_dead_tokens_get_200`

**Nothing about the token itself is an error.** A token the server never issued, a refresh token whose family has expired, and an access token minted for another server all get `200`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs unknown_and_dead_tokens_get_200}}

Relies on [`verify_jwt`](<../Domain/Token Explanation.md#verify_jwt>).

## `a_wrong_token_type_hint_still_revokes`

**The hint is never needed.** A refresh token hinted as an access token is still found and revoked.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs a_wrong_token_type_hint_still_revokes}}

## `an_unknown_client_is_invalid_client`

**A client the server doesn't know can't revoke anything.** It is `401 invalid_client`, and the token it presented still refreshes for its own client.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs an_unknown_client_is_invalid_client}}

## `a_confidential_client_revokes_with_its_secret`

**A confidential client must authenticate with its secret, as at `/oauth/token`.** A wrong secret is `401 invalid_client` with a `Basic` challenge. The right one revokes, and the token then fails to refresh.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs a_confidential_client_revokes_with_its_secret}}

The fixture is [`spin_up_with_confidential_client`](<../Integration Tests Explanation.md#spin_up_with_confidential_client>); the [Client Auth](<Client Auth Explanation.md>) page covers client authentication.

## `a_malformed_request_is_invalid_request`

**A request with no `token`, or not form-encoded, is `400 invalid_request`.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs a_malformed_request_is_invalid_request}}

## `bumping_the_client_s_epoch_stops_refresh`

**Bumping a client's revocation epoch stops every refresh family it held.** Here the Owner revokes the app's subject. The app's next refresh is refused "Refresh token has been revoked". The other client's epoch is its own, so it still refreshes.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs bumping_the_client_s_epoch_stops_refresh}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#refreshtokenfamily>)'s `issued_at`; the epoch check is in {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::validate}}.

## `a_family_begun_after_the_epoch_refreshes`

**The epoch only reaches back.** A family that began after the client's epoch refreshes as usual.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs a_family_begun_after_the_epoch_refreshes}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#refreshtokenfamily>).
