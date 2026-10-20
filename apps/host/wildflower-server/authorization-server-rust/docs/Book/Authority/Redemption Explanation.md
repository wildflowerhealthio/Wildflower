# Redemption

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs}}

An app's back end comes to `/oauth/token` holding something it was given earlier: an [authorization code](<../Domain/Authorization Code Explanation.md>), a device code, or a [refresh token](<../Domain/Refresh Token Explanation.md>). It has already proved who it is with an [authenticated client](<Authenticated Client Explanation.md>). **Before an access token is minted for it, the thing it holds is redeemed into a proof**, one per grant type. Each proof has one constructor, and that constructor is the whole redemption rule for its grant type: the single-use claim, the bindings to the app and redirect, the expiry, the PKCE check.

**A proof's scopes are copied from the record it redeemed**, never from the request. The code carries the scopes its approval recorded; the device request carries the scopes the Owner granted; the refresh family carries the scopes it was started with. So a token can hold only what the consent behind it recorded.

Some refusals come after a write: a code is spent before its bindings are checked, a pending device poll is stamped before it is answered. Those refusals are the inner `Err` of a nested result, so the token exchange's scope commits what it wrote rather than rolling it back. Only a store failure is the outer `Err`, and the [token-exchange errors](<../Domain/Errors Explanation.md#item-TokenExchangeError>) are the inner one's vocabulary.

## `domain::authority::redemption`

The tests issue codes, store refresh families and read refusals with the [redemption fixtures](<Test Fixtures Explanation.md#redemption>).

### `PresentedAuthorizationCode`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs PresentedAuthorizationCode}}

### `RedeemedAuthorizationCode`

It keeps the [issued code](<../Domain/Authorization Code Explanation.md#item-AuthorizationCode>) whole.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode}}

#### `redeem`

The code is taken out of the store in one step ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_codes.rs AuthorizationCodesTx::redeem_authorization_code}}), so of two redemptions racing for one code, only one gets it back. A code that comes back missing may be a replay, so every refresh family started from it is expired ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs RefreshTokensTx::expire_refresh_token_families_for_authorization_code}}) before the refusal. A standing grant revoked between approval and redemption just leaves the proof's `grant_id` empty.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::redeem tests="tests::a_code_redeems_once_with_its_recorded_claims tests::a_code_is_refused_for_each_broken_binding"}}

End to end, the [Grant Flows](<../Integration Tests/Grant Flows Explanation.md>) and [OAuth Endpoints](<../Integration Tests/OAuth Endpoints Explanation.md>) tests hold each refusal at `/oauth/token`, and that a replayed code ends the refresh family it started.

#### Getters

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::client_id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::token_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::granted_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::patient}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::authorization_code}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::sid}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::grant_id}}

### `check_code_bindings`

Each failure is its own `invalid_grant` reason, for the log; the wire answer is `invalid_grant` whichever failed. The code is already spent, so none of them can be retried into a token.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs check_code_bindings}}

### `token_scope_spellings`

All three proofs build their token scopes with it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs token_scope_spellings}}

### `ConsumedDeviceRequest`

It carries the Owner's [approval](<../Domain/Authorization Request Explanation.md#item-Approval>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ConsumedDeviceRequest}}

#### `consume`

**A device request is claimed once.** The claim is the request's own [`claim`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--claim>) transition, written with the guarded replace under the scope's write lock, so of two polls racing for one approval, one wins. The standing grant is found by the device's [grant name](<../Domain/Authorization Request/Polled Requests Explanation.md#item-device_grant_name>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ConsumedDeviceRequest::consume tests="tests::a_device_request_reports_its_status_and_is_claimed_once"}}

End to end, the [Device Code](<../Integration Tests/Device Code Explanation.md>) tests hold the poll answers at `/oauth/token`: `device_grant_pending_then_slow_down` and `device_grant_single_use_then_expired_token`.

#### Getters

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ConsumedDeviceRequest::client_id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ConsumedDeviceRequest::token_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ConsumedDeviceRequest::granted_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ConsumedDeviceRequest::patient}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ConsumedDeviceRequest::grant_id}}

### `ValidatedRefreshToken`

It reads its [refresh token family](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>). **It is not consumed yet**: the refresh-family writer consumes it, by the hash it carries, when it rotates the token into its successor.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken}}

#### `validate`

The epoch is the app's revocation epoch: bumping it revokes every token the app held at that instant, so a family begun before it is refused like an access token issued before it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::validate tests="tests::a_refresh_token_validates_for_its_client_while_the_family_lives tests::a_refresh_token_is_refused_once_its_session_is_revoked tests::a_refresh_token_is_refused_once_its_client_epoch_passes_the_family"}}

End to end, the [Device Code](<../Integration Tests/Device Code Explanation.md>), [Browser Sessions](<../Integration Tests/Browser Sessions Explanation.md>) and [Token Revocation](<../Integration Tests/Token Revocation Explanation.md>) tests hold each refusal at `/oauth/token`: an expired family, another app's token, a revoked browser session, and a bumped epoch.

#### `revalidate`

It runs the store checks `validate`'s tests exercise.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::revalidate}}

#### `live_family`

The half both constructors run. A revoked family is one whose deadline was pulled back to the revocation instant, so the deadline check covers both. The browser session is checked with {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs BrowserSessionsTx::is_browser_session_revoked}}.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::live_family}}

#### Getters

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::client_id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::token_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::granted_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::patient}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::sid}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::device_grant_id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::family_id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::presented_hash}}

### `GrantRedemption`

The two proofs above that establish a session, read through for the refresh family they start.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs GrantRedemption}}

#### Getters

The first test under [`redeem`](#item-RedeemedAuthorizationCode--redeem) and the one under [`consume`](#item-ConsumedDeviceRequest--consume) read `authorization_code` either way.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs GrantRedemption::client_id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs GrantRedemption::patient}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs GrantRedemption::granted_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs GrantRedemption::authorization_code}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs GrantRedemption::sid}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs GrantRedemption::grant_id}}

#### `is_refresh_token_earned`

The token exchange asks it before it starts a family. Its test sits with the writer that starts one, on the [Refresh Family Writer](<../Writers/Refresh Family Writer Explanation.md>) page.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs GrantRedemption::is_refresh_token_earned}}
