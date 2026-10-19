# Token Exchanger

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs}}

`POST /oauth/token` is where an app turns what it was given into a token it can call the FHIR server with. It has three ways in: an [authorization code](<../../Domain/Authorization Code Explanation.md>) the Owner's approval issued, a device request the Owner approved, or a [refresh token](<../../Domain/Refresh Token Explanation.md>) from an earlier exchange. The token exchanger runs all three, always for an app that has [authenticated](<Client Authenticator Explanation.md#authenticate>).

Every exchange has the same spine. **The app must be registered for the grant type it uses**, checked before any scope opens, so a refused app spends nothing. Then, inside a write scope: obtain the redemption proof, load the signing key, start or rotate the refresh family, and sign the token. **The proof is the hand-off between checking and writing**, so a token is never minted for a grant that didn't redeem.

**Signing runs inside the scope, so a signing failure undoes the exchange**: the code stays unspent, the device request unclaimed, the refresh token unrotated, and the app can try again. A refusal is different. It comes back as an inner `Err`, which the scope commits, because some refusals must keep what they wrote: the spent code of a failed redemption, the stamped poll of a device that polled too early, the ended family of a replayed refresh token.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs ExchangeOutcome}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger}}

It holds the store, the revocation check a refresh runs against its client's epoch, and the server's origin, every minted token's `iss` and `aud`. `new` builds it from those handles, lifted from the state.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::new}}

What every exchange answers is the RFC 6749 token response. The scopes it reports are the scopes as granted; the token's own `scope` claim carries each SMART scope's alternate spelling too.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs IssuedTokens}}

The refusals are a `TokenExchangeError`, described with the [errors](<../../Domain/Errors Explanation.md>).

## The shared steps

The grant-type gate reads the app's registration ([`allows_grant_type`](<../../Authority/Authenticated Client Explanation.md#allows_grant_type>)). A miss is `unauthorized_client`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs ensure_grant_type_allowed}}

The two grants that start a session, a code and a device approval, then prepare the same way. The [minter](<../../Writers/Access Token Minter Explanation.md#with_active_key>) loads the active signing key first, so a server with no key fails before writing a family. **A grant holding `offline_access` earns a refresh family** ([`earns_refresh_token`](<../../Authority/Redemption Explanation.md#earns_refresh_token>)), which the [refresh-family writer](<../../Writers/Refresh Family Writer Explanation.md#start_family>) starts.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::prepare_issuance}}

Every exchange ends by signing. The access token lives `ACCESS_TOKEN_TTL`, and `expires_in` reports it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs issue}}

## Test fixtures

`exchanger` builds the capability over a fake store holding an active signing key, with a revocation check under which nothing is revoked. `authenticated` authenticates a public client registered for the given grant types. `issue_code` issues a code for a client and scopes, bound to the PKCE verifier `VERIFIER`, the redirect `https://example.com/cb` and the fixture browser session.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs tests::exchanger}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs tests::authenticated}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs tests::issue_code}}

## `exchange_authorization_code`

**An app redeems its code with the PKCE verifier and gets the token the Owner's approval authorized.** Inside one write scope the code is redeemed for the [`RedeemedAuthorizationCode`](<../../Authority/Redemption Explanation.md#redeem>) proof. That proof consumes the code, single use, and checks it is this app's, at this redirect, unexpired, and matching the verifier. A code that is gone is a possible replay, and any family it started is ended before the refusal. The token carries the code's granted scopes, its patient and its browser session.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::exchange_authorization_code}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::redeem_code_in}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs tests::a_client_without_the_grant_type_is_refused_before_redemption}}

An app registered only for the device flow presents a good code: `UnauthorizedGrantType`, and the code is still there to redeem.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs tests::a_code_exchange_mints_for_the_granted_scopes}}

A code granting `openid` yields a token for `openid` that verifies with the server's origin as `iss` and `aud`, with `expires_in` the access token's lifetime and no refresh token. A code granting `offline_access` as well yields a refresh token.

Exercised end to end by [`auth_code_grant_happy_path_end_to_end`](<../../Integration Tests/Grant Flows Explanation.md#auth_code_grant_happy_path_end_to_end>), [`auth_code_grant_wrong_verifier_rejected`](<../../Integration Tests/Grant Flows Explanation.md#auth_code_grant_wrong_verifier_rejected>), [`auth_code_grant_replay_rejected`](<../../Integration Tests/Grant Flows Explanation.md#auth_code_grant_replay_rejected>), [`auth_code_replay_revokes_issued_refresh_family`](<../../Integration Tests/Grant Flows Explanation.md#auth_code_replay_revokes_issued_refresh_family>) and [`token_endpoint_rejects_grant_outside_client_allow_list`](<../../Integration Tests/Device Code Explanation.md#token_endpoint_rejects_grant_outside_client_allow_list>).

## `exchange_device_code`

**A device polls with its `device_code`, and the first poll after the Owner approves gets the token.** Inside one write scope the request is consumed for the [`ConsumedDeviceRequest`](<../../Authority/Redemption Explanation.md#consume>) proof. A code naming no device request of this app's is `invalid_grant`, and a request past its expiry `expired_token`. A pending request answers `slow_down` to a poll inside the poll interval, which records nothing; any other poll is stamped and answers `authorization_pending`. A denied request answers `access_denied`, and one already claimed `expired_token`. An approved one is claimed, single use, under the scope's write lock, so two concurrent polls can't both mint. The token carries the scopes and patient the Owner approved.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::exchange_device_code}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::claim_device_request_in}}

No unit test of its own. Exercised end to end by [`device_grant_pending_then_slow_down`](<../../Integration Tests/Device Code Explanation.md#device_grant_pending_then_slow_down>), [`device_grant_single_use_then_expired_token`](<../../Integration Tests/Device Code Explanation.md#device_grant_single_use_then_expired_token>), [`device_approval_mints_durable_grant_and_links_refresh_family`](<../../Integration Tests/Device Code Explanation.md#device_approval_mints_durable_grant_and_links_refresh_family>) and [`the_token_endpoint_cannot_mint_a_browser_token`](<../../Integration Tests/Browser Pairing Explanation.md#the_token_endpoint_cannot_mint_a_browser_token>).

## `exchange_refresh_token`

**An app trades a live refresh token for a fresh access token and the refresh token's successor.** The family keeps its scopes, its patient and its absolute deadline: rotation never extends its life.

**This is the one exchange with two scopes**, a read scope and then a write scope.

The read scope runs the whole validation, [`ValidatedRefreshToken::validate`](<../../Authority/Redemption Explanation.md#validate>): the token's family must be this app's, unexpired, not minted under a revoked browser session, and begun no earlier than the app's revocation epoch. **The epoch is why the read comes first.** Bumping an app's epoch revokes every token it held at that instant, families included, and the epoch lives on the revocation store. That store reaches the same database file through a different connection from the grant store's. A write scope takes the file's write lock as it opens. Reading the epoch through the other connection while holding that lock risks a lock-order stall, the two connections waiting on each other until the busy timeout. Reading it before any write lock is taken avoids that.

The write scope then [re-validates](<../../Authority/Redemption Explanation.md#revalidate>) the store-only facts (the app's, unexpired, the session not revoked), since the family may have ended between the two scopes, for example by a replay on another request. The epoch isn't read again. An epoch bumped between the two scopes doesn't stop this one rotation, but the family still began before the epoch, so its next refresh is refused. Then the scope loads the signing key, [rotates](<../../Writers/Refresh Family Writer Explanation.md#rotate>) the token and signs. **A token already rotated is a replay**: the whole family is ended at once, and the scope keeps that end even though it refuses.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::exchange_refresh_token}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::rotate_refresh_token_in}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs tests::a_refresh_exchange_rotates_and_a_replay_revokes_the_family}}

A code granting `openid offline_access` yields a refresh token. Refreshing with it returns a successor and the family's scopes. Presenting the first token again is `RefreshTokenReplayed`, and the successor then answers `RefreshTokenExpired`: the replay ended the family.

Exercised end to end by [`offline_access_issues_rotating_refresh_token`](<../../Integration Tests/Device Code Explanation.md#offline_access_issues_rotating_refresh_token>), [`refresh_token_is_bound_to_issuing_client`](<../../Integration Tests/Device Code Explanation.md#refresh_token_is_bound_to_issuing_client>), [`expired_refresh_token_family_is_rejected`](<../../Integration Tests/Device Code Explanation.md#expired_refresh_token_family_is_rejected>), [`bumping_the_client_s_epoch_stops_refresh`](<../../Integration Tests/Token Revocation Explanation.md#bumping_the_client_s_epoch_stops_refresh>), [`a_family_begun_after_the_epoch_refreshes`](<../../Integration Tests/Token Revocation Explanation.md#a_family_begun_after_the_epoch_refreshes>) and [`an_app_authorized_in_a_session_is_ended_with_it`](<../../Integration Tests/Browser Sessions Explanation.md#an_app_authorized_in_a_session_is_ended_with_it>).
