# Token Revocation

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs}}

`POST /oauth/revoke` (RFC 7009) is how an app gives up a token it holds, say when its user signs out of it. The app authenticates as it does at `/oauth/token`: a public client by its `client_id`, a confidential one with its secret too. Then:

- **A refresh token ends its whole family**, whichever generation is presented.
- **An access token is denylisted by its `jti`** until it expires, if this server minted it for that client.
- **Anything else is answered alike and left alone**: a token the server never issued, one already dead, another server's, and another client's. The answer is always `200` with an empty body, so an app learns nothing about a token that isn't its own.

The server tells the token's type from the token itself and never reads `token_type_hint`. The revoker is [`ClientTokenRevoker::revoke`](<../Capabilities/OAuth/Client Token Revoker Explanation.md#item-ClientTokenRevoker--revoke>). The file's last two tests hold refresh redemption to the client's revocation epoch, which [Revocation](<Revocation Explanation.md>) introduces: a family begun before its client's epoch no longer refreshes.

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationtoken_revocation>) page, with the shared ones.

## `integration::token_revocation`

### `an_app_revokes_its_own_refresh_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs an_app_revokes_its_own_refresh_token}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`seed_public_clients`](<Test Fixtures Explanation.md#item-seed_public_clients>), [`plant_refresh_token`](<Test Fixtures Explanation.md#item-plant_refresh_token>), [`store_handle`](<Test Fixtures Explanation.md#item-store_handle>), [`APP_CLIENT_ID`](<Test Fixtures Explanation.md#item-APP_CLIENT_ID>), [`refresh`](<Test Fixtures Explanation.md#item-refresh>), [`body_json`](<Test Fixtures Explanation.md#item-body_json>), [`assert_revocation_answered`](<Test Fixtures Explanation.md#item-assert_revocation_answered>), [`revoke`](<Test Fixtures Explanation.md#item-token_revocation--revoke>) and [`assert_refresh_revoked`](<Test Fixtures Explanation.md#item-assert_refresh_revoked>).

### `an_app_revokes_its_own_access_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs an_app_revokes_its_own_access_token}}

Relies on [`verify_access_token`](<../Domain/Access Token Explanation.md#item-verify_access_token>) and [`AccessTokenClaims`](<../Domain/Access Token Explanation.md#item-AccessTokenClaims>). Fixtures first used here: [`mint_client_token`](<Test Fixtures Explanation.md#item-mint_client_token>), [`owner_grants_probe`](<Test Fixtures Explanation.md#item-owner_grants_probe>), [`revocation_store_handle`](<Test Fixtures Explanation.md#item-revocation_store_handle>) and [`jti_of`](<Test Fixtures Explanation.md#item-jti_of>).

### `another_client_s_tokens_are_answered_alike_and_left_alone`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs another_client_s_tokens_are_answered_alike_and_left_alone}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>). Fixtures first used here: [`OTHER_CLIENT_ID`](<Test Fixtures Explanation.md#item-OTHER_CLIENT_ID>).

### `unknown_and_dead_tokens_get_200`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs unknown_and_dead_tokens_get_200}}

Relies on [`verify_access_token`](<../Domain/Access Token Explanation.md#item-verify_access_token>). Fixtures first used here: [`mint_token_naming`](<Test Fixtures Explanation.md#item-mint_token_naming>).

### `an_unknown_client_is_invalid_client`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs an_unknown_client_is_invalid_client}}

Relies on [`AuthenticatedClient::authenticate`](<../Authority/Authenticated Client Explanation.md#item-AuthenticatedClient--authenticate>).

### `a_confidential_client_revokes_with_its_secret`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs a_confidential_client_revokes_with_its_secret}}

Relies on [`AuthenticatedClient::authenticate`](<../Authority/Authenticated Client Explanation.md#item-AuthenticatedClient--authenticate>). Fixtures first used here: [`spin_up_with_confidential_client`](<Test Fixtures Explanation.md#item-spin_up_with_confidential_client>), [`post_form_with_authorization`](<Test Fixtures Explanation.md#item-post_form_with_authorization>), [`basic_authorization`](<Test Fixtures Explanation.md#item-basic_authorization>), [`CONFIDENTIAL_CLIENT_ID`](<Test Fixtures Explanation.md#item-CONFIDENTIAL_CLIENT_ID>) and [`CONFIDENTIAL_CLIENT_SECRET`](<Test Fixtures Explanation.md#item-CONFIDENTIAL_CLIENT_SECRET>).

### `a_wrong_token_type_hint_still_revokes`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs a_wrong_token_type_hint_still_revokes}}

Relies on [`ClientTokenRevoker::revoke`](<../Capabilities/OAuth/Client Token Revoker Explanation.md#item-ClientTokenRevoker--revoke>). Fixtures first used here: [`post_form_body`](<Test Fixtures Explanation.md#item-post_form_body>).

### `a_malformed_request_is_invalid_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs a_malformed_request_is_invalid_request}}

Relies on [`ClientTokenRevoker::revoke`](<../Capabilities/OAuth/Client Token Revoker Explanation.md#item-ClientTokenRevoker--revoke>). Fixtures first used here: [`build_request`](<Test Fixtures Explanation.md#item-build_request>).

### `bumping_the_client_s_epoch_stops_refresh`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs bumping_the_client_s_epoch_stops_refresh}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>)'s `issued_at`; the epoch check is in [`ValidatedRefreshToken::validate`](<../Authority/Redemption Explanation.md#item-ValidatedRefreshToken--validate>). Fixtures first used here: [`owner_revocation_request`](<Test Fixtures Explanation.md#item-owner_revocation_request>).

### `a_family_begun_after_the_epoch_refreshes`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs a_family_begun_after_the_epoch_refreshes}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>).
