# Redemption

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs}}

An app's back end comes to `/oauth/token` holding something it was given earlier: an authorization code, a device code, or a refresh token. **Before an access token is minted for it, the thing it holds is redeemed into a proof**, one per grant type. Each proof has one constructor, and that constructor is the whole redemption rule for its grant type: the single-use claim, the bindings to the app and redirect, the expiry, the PKCE check.

**A proof's scopes are copied from the record it redeemed**, never from the request. The code carries the scopes its approval recorded; the device request carries the scopes the Owner granted; the refresh family carries the scopes it was started with. So a token can hold only what the consent behind it recorded. The access-token minter takes the proof through its [`TokenEntitlement`](<Token Entitlement Explanation.md#tokenentitlement>) variant; the refresh-family writer takes it to [start](<../Writers/Refresh Family Writer Explanation.md#start_family>) or [rotate](<../Writers/Refresh Family Writer Explanation.md#rotate>) a family.

Every constructor runs inside the token exchange's write scope, except the refresh token's first check, which runs in a read scope (see [`validate`](#validate)). Some refusals come after a write: a code is spent before its bindings are checked, a pending device poll is stamped before it is answered. Those refusals are the inner `Err` of a nested result, so the scope commits what it wrote rather than rolling it back. Only a store failure is the outer `Err`.

## Test fixtures

`authenticated` registers a public client and authenticates as it, through the test fake's [`authenticated_public_client`](<../Grant Store/Test Fake Explanation.md#authenticated_public_client>):

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::authenticated}}

The code tests issue every code for one redirect and one PKCE verifier:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::REDIRECT}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::redirect}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::VERIFIER}}

`issued_code` stores a code for `client_id`, issued at `now`, bound to that redirect and verifier, to patient `pat-1` and to browser session `sid-1`, granting `patient/Patient.read`. A test issues one in the past to get an expired code:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::issued_code}}

`reason` unwraps a refusal to its `invalid_grant` reason, and fails the test on anything else:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::reason}}

`live_family` and `live_family_under` store refresh family `fam` for a client, live for a day from `now`, with `openid offline_access` and one unconsumed token whose plaintext is `live`. The second records the browser session the family was started under:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::live_family}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::live_family_under}}

## `PresentedAuthorizationCode`

The three values of an `authorization_code` grant request that redemption checks, as the app sent them: the code, the PKCE verifier, and the redirect URI named again.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs PresentedAuthorizationCode}}

## `RedeemedAuthorizationCode`

The proof that a code was consumed and every binding held. It keeps the [issued code](<../Domain/Authorization Code Explanation.md#issuedauthorizationcode>) whole, the scopes the token will carry, and the standing grant behind it, if one was found.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode}}

Its getters read the code as issued: `client_id`, `granted_scopes`, `patient`, `authorization_code` (the code itself), `sid` (the browser session the request was made in) and `grant_id`. `token_scopes` is what goes in the token's `scope` claim: each granted scope with its alternate SMART spelling added, so a v1-worded grant also carries its v2 letter spelling. The token response's `scope` stays the granted set as it is. The other two proofs build their `token_scopes` the same way:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs token_scope_spellings}}

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::client_id RedeemedAuthorizationCode::token_scopes RedeemedAuthorizationCode::granted_scopes RedeemedAuthorizationCode::patient RedeemedAuthorizationCode::authorization_code RedeemedAuthorizationCode::sid RedeemedAuthorizationCode::grant_id}}

## `redeem`

**A code is spent the moment it is presented, and only then checked.** The request must first be well formed: a verifier of the wrong length or a redirect that doesn't parse is refused before the code is touched. Then the code is taken out of the store in one step ([`redeem_authorization_code`](<../Grant Store/Authorization Codes Explanation.md#redeem_authorization_code>)), so of two redemptions racing for one code, only one gets it back.

A code that comes back missing was never issued or was already redeemed. Either way it may be a replay, so **every refresh family started from that code is expired** before the refusal ([`expire_refresh_token_families_for_authorization_code`](<../Grant Store/Refresh Tokens Explanation.md#expire_refresh_token_families_for_authorization_code>)). The [Authorization Code page](<../Domain/Authorization Code Explanation.md#redeemed-once>) tells this half of the story.

A code that comes back is checked against the app that presented it. Each failure is its own `invalid_grant` reason, for the log; the wire answer is `invalid_grant` whichever failed. The code is already spent, so none of them can be retried into a token. Past the checks, the standing grant for the app and redirect is looked up and recorded on the proof. A grant revoked since the approval just leaves it empty.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::redeem}}

The bindings, in order: the code is this app's, for this redirect, not past its expiry (the expiry instant itself still redeems), and its PKCE challenge is the S256 hash of the presented verifier, compared in constant time.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs check_code_bindings}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::a_code_redeems_once_with_its_recorded_claims}}

A bound, unexpired code with the right verifier redeems. The proof carries the code's app, patient and scopes, the token scopes with `patient/Patient.rs` added beside `patient/Patient.read`, and the code itself. The same code presented again is `CodeNotFoundOrRedeemed`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::a_code_is_refused_for_each_broken_binding}}

A fresh code per case: another app presenting it, another redirect, a code issued past its lifetime, and a wrong verifier each refuse with their own reason.

Exercised end to end by [`auth_code_grant_happy_path_end_to_end`](<../Integration Tests/Grant Flows Explanation.md#auth_code_grant_happy_path_end_to_end>), [`auth_code_grant_wrong_verifier_rejected`](<../Integration Tests/Grant Flows Explanation.md#auth_code_grant_wrong_verifier_rejected>), [`auth_code_grant_expired_code_rejected`](<../Integration Tests/Grant Flows Explanation.md#auth_code_grant_expired_code_rejected>), [`auth_code_grant_replay_rejected`](<../Integration Tests/Grant Flows Explanation.md#auth_code_grant_replay_rejected>), [`auth_code_replay_revokes_issued_refresh_family`](<../Integration Tests/Grant Flows Explanation.md#auth_code_replay_revokes_issued_refresh_family>), [`token_exchange_unknown_code_returns_400_invalid_grant`](<../Integration Tests/OAuth Endpoints Explanation.md#token_exchange_unknown_code_returns_400_invalid_grant>) and [`token_exchange_short_code_verifier_returns_400_invalid_grant`](<../Integration Tests/OAuth Endpoints Explanation.md#token_exchange_short_code_verifier_returns_400_invalid_grant>).

## `ConsumedDeviceRequest`

The proof that an approved device request was claimed by this poll. It carries the polling app, the Owner's [approval](<../Domain/Authorization Request Explanation.md#approve_device>) (granted scopes and patient), the token scopes, and the standing device grant behind it, if one was found.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ConsumedDeviceRequest}}

Its getters are `client_id`, `token_scopes` (spelled as for a code), `granted_scopes`, `patient` and `grant_id`.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ConsumedDeviceRequest::client_id ConsumedDeviceRequest::token_scopes ConsumedDeviceRequest::granted_scopes ConsumedDeviceRequest::patient ConsumedDeviceRequest::grant_id}}

## `consume`

A device polls `/oauth/token` with its `device_code` until the Owner decides. Each poll is answered by the request's state:

| The request                                     | The poll's answer                                  |
| ----------------------------------------------- | -------------------------------------------------- |
| unknown, another app's, or not a device request | `invalid_grant`, the three alike                   |
| past its expiry, whatever its status            | `expired_token`                                    |
| pending, polled again within five seconds       | `slow_down`, and the poll is not stamped           |
| pending otherwise                               | `authorization_pending`, and the poll is stamped   |
| denied                                          | `access_denied`                                    |
| already claimed                                 | `expired_token`: the device code has done its work |
| approved                                        | claimed, and the proof returned                    |

**A request is claimed once.** The claim is a [guarded replace](<../Domain/Authorization Request Explanation.md#the-guarded-replace-first-decision-wins>) of the approved request by its [`claim`](<../Domain/Authorization Request Explanation.md#claim>), under the scope's write lock. A poll that loses a race to it is refused as `invalid_grant`. Once claimed, the standing device grant is looked up by the app and the device's grant name ([`device_grant_name`](<../Domain/Authorization Request Explanation.md#device_grant_name>)) and recorded on the proof.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ConsumedDeviceRequest::consume}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::a_device_request_reports_its_status_and_is_claimed_once}}

The first poll of a pending request is `authorization_pending`, and one a second later is `slow_down`. Another app polling with the same code is `DeviceRequestNotFound`. After approval, a poll a full interval later claims the request, carrying the polling app and the granted scopes and no authorization code; the next poll is `expired_token`.

Exercised end to end by [`device_grant_pending_then_slow_down`](<../Integration Tests/Device Code Explanation.md#device_grant_pending_then_slow_down>), [`device_grant_single_use_then_expired_token`](<../Integration Tests/Device Code Explanation.md#device_grant_single_use_then_expired_token>) and [`token_exchange_unknown_device_code_returns_400_invalid_grant`](<../Integration Tests/OAuth Endpoints Explanation.md#token_exchange_unknown_device_code_returns_400_invalid_grant>).

## `ValidatedRefreshToken`

The proof that a presented refresh token belongs to a live family of the app presenting it. **It is not consumed yet.** The [refresh-family writer](<../Writers/Refresh Family Writer Explanation.md#rotate>) consumes it, by the hash it carries, when it rotates the token into its successor.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken}}

Its getters read the [family](<../Domain/Refresh Token Explanation.md#refreshtokenfamily>): `client_id`, `granted_scopes`, `patient`, `sid` and `family_id`, with `token_scopes` spelled as for a code and `presented_hash`, the storage hash of the token as presented.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::client_id ValidatedRefreshToken::token_scopes ValidatedRefreshToken::granted_scopes ValidatedRefreshToken::patient ValidatedRefreshToken::sid ValidatedRefreshToken::family_id ValidatedRefreshToken::presented_hash}}

The store-only half of the check, which both constructors run: the token must resolve to a family ([`refresh_token_with_family_by_hash`](<../Grant Store/Refresh Tokens Explanation.md#refresh_token_with_family_by_hash>)), the family must be this app's, its deadline must not have passed, and the browser session it was started under must not be revoked or gone ([`browser_session_is_revoked`](<../Grant Store/Browser Sessions Explanation.md#browser_session_is_revoked>)). A revoked family is one whose deadline was pulled back to the revocation instant, so the deadline check covers both. A family with no browser session, as from the device flow, has none to check.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::live_family}}

## `validate`

**A token presented by the wrong app is answered like an unknown one, and refused before anything is consumed**, so a stranger can neither probe whether a token is valid nor burn the rightful app's token. Past the store checks, the app's revocation epoch: bumping it revokes every token the app held at that instant, and a family begun before the epoch is refused like an access token issued before it. A family begun at the epoch itself still validates. An epoch that can't be read is a store failure, so it never lets a family through.

The epoch lives on the revocation store, another connection to the same database file. Reading it under the exchange's write lock could stall the two connections against each other, so `validate` runs in a read scope of its own, before the write scope opens.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::validate}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::a_refresh_token_validates_for_its_client_while_the_family_lives}}

A live token validates for its own app, carrying its family, hash and scopes. An unknown token, the same token from another app, and the token after its family's deadline each refuse with their own reason.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::a_refresh_token_is_refused_once_its_session_is_revoked}}

A family started under a standing browser session validates and carries its `sid`. Once the session is revoked, it is refused; so is a family whose `sid` names no stored session.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::a_refresh_token_is_refused_once_its_client_epoch_passes_the_family}}

An epoch bumped to the family's own start still validates, and so does another app's epoch bumped later. The app's epoch bumped one second past the start refuses the family as `RefreshTokenClientRevoked`.

Exercised end to end by [`expired_refresh_token_family_is_rejected`](<../Integration Tests/Device Code Explanation.md#expired_refresh_token_family_is_rejected>), [`refresh_token_is_bound_to_issuing_client`](<../Integration Tests/Device Code Explanation.md#refresh_token_is_bound_to_issuing_client>), [`an_app_authorized_in_a_session_is_ended_with_it`](<../Integration Tests/Browser Sessions Explanation.md#an_app_authorized_in_a_session_is_ended_with_it>), [`bumping_the_client_s_epoch_stops_refresh`](<../Integration Tests/Token Revocation Explanation.md#bumping_the_client_s_epoch_stops_refresh>) and [`a_family_begun_after_the_epoch_refreshes`](<../Integration Tests/Token Revocation Explanation.md#a_family_begun_after_the_epoch_refreshes>).

## `revalidate`

The family may have ended between the read scope closing and the write scope opening. So inside the write scope that rotates, the store-only half runs again on the same hash: this app's, before its deadline, its browser session not revoked. The epoch was checked in `validate` and is not read again.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::revalidate}}

No unit test of its own; it runs the same store checks [`validate`](#validate)'s tests exercise.

## `GrantRedemption`

**Only a grant that establishes a session may start a refresh-token family**: a redeemed code or a claimed device request. A refresh only rotates the family it already belongs to, so it is not one of these.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs GrantRedemption}}

Its getters read through to the proof, for the family's record: `client_id`, `patient`, `granted_scopes` (as granted, without the alternate spellings), `grant_id`, and two the device flow doesn't have: `authorization_code`, the consumed code, so a replay of it can revoke the family, and `sid`, the browser session the code was issued under. Both are `None` for a device request; the first test under [`redeem`](#redeem) and the one under [`consume`](#consume) check `authorization_code` either way.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs GrantRedemption::client_id GrantRedemption::patient GrantRedemption::granted_scopes GrantRedemption::authorization_code GrantRedemption::sid GrantRedemption::grant_id}}

## `earns_refresh_token`

**A refresh-token family comes only with `offline_access`.** The token exchange asks this before it starts one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs GrantRedemption::earns_refresh_token}}

Its test lives with the writer that acts on it: [`only_offline_access_earns_a_refresh_token`](<../Writers/Refresh Family Writer Explanation.md#only_offline_access_earns_a_refresh_token>).
