# Refresh Family Writer

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs}}

A refresh token is a standing credential: with it, an app gets fresh access tokens long after the person who approved it has left. Refresh tokens come in [families](<../Domain/Refresh Token Explanation.md#refreshtokenfamily>). A family starts with one token when a grant is redeemed, and each refresh consumes the token presented and adds its successor, so one token in a family is live at a time. The family holds what every token in it is good for: the app, the scopes, the patient, the deadline.

The refresh-family writer starts families and rotates tokens. **Both take a redemption proof**, so a refresh token is only ever minted for scopes a consumed code or a claimed device request recorded, and only ever rotated within a family that validated for the app presenting it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter}}

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter::within}}

`within` builds the writer over the token exchange's open write scope.

## `only_offline_access_earns_a_refresh_token`

**A family comes only with `offline_access`.** The token exchange asks the redemption's [`earns_refresh_token`](<../Authority/Redemption Explanation.md#earns_refresh_token>) before it starts one; the writer itself doesn't ask.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs tests::only_offline_access_earns_a_refresh_token}}

A code redeemed for `openid` alone earns none; one redeemed for `openid offline_access` does.

## `start_family`

A redeemed code or a claimed device request ([`GrantRedemption`](<../Authority/Redemption Explanation.md#grantredemption>)) starts a new family with its first token, and the token's plaintext goes back to the app; the store keeps only its hash. **The family records the redemption verbatim**: its app, scopes and patient, the standing grant behind it, a hash of the code it consumed, so a replay of that code can expire the family, and the browser session the code was issued under, so revoking that browser ends it. A device-flow family has neither code nor session. The family's deadline is [`REFRESH_TOKEN_FAMILY_TTL`](<../Domain/Refresh Token Explanation.md#refresh_token_family_ttl>) from now, and rotation never extends it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter::start_family}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs tests::start_family_records_the_redemption}}

With a standing grant planted for the app, the returned plaintext resolves to an unconsumed first token whose family records the app, the scopes, the patient, the code's hash, the grant, and the deadline.

Exercised end to end by [`offline_access_issues_rotating_refresh_token`](<../Integration Tests/Device Code Explanation.md#offline_access_issues_rotating_refresh_token>) and [`device_approval_mints_durable_grant_and_links_refresh_family`](<../Integration Tests/Device Code Explanation.md#device_approval_mints_durable_grant_and_links_refresh_family>).

## Test fixtures

`validated` validates a token for the app `client` through the real [`validate`](<../Authority/Redemption Explanation.md#validate>), with nothing revoked, as the token exchange's read scope would:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs tests::validated}}

## `rotate`

**The presented token is consumed, and only if that consume won is its successor added.** The consume ([`consume_refresh_token`](<../Domain/Refresh Token Explanation.md#consume_refresh_token>)) is the single-use claim.

**A token presented after it was consumed is a replay.** Either the token leaked or the app is badly broken; either way the lineage can't be trusted, so the whole family is expired at `now` before the refusal, and the app must be authorized again. A token that vanished between validation and rotation is refused with nothing to expire. Both refusals are the inner `Err`, so the exchange's scope keeps the family's end.

**An app refreshing is its browser session in use.** A family started under a browser session moves that session's `last_seen_at` to now.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter::rotate}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs tests::rotate_consumes_then_replay_expires_the_family}}

The first rotation returns a successor that resolves in the store. Rotating the same presented token again is `RefreshTokenReplayed`, and the successor's family now has its deadline at the replay's instant.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs tests::rotate_marks_the_family_s_browser_session_seen}}

Two families, one started under a browser session and one under none. Rotating the second leaves the session's `last_seen_at` where it was; rotating the first moves it to the rotation's instant.

Exercised end to end by [`offline_access_issues_rotating_refresh_token`](<../Integration Tests/Device Code Explanation.md#offline_access_issues_rotating_refresh_token>) and [`token_exchange_with_basic_auth_redeems_refresh_token`](<../Integration Tests/Client Auth Explanation.md#token_exchange_with_basic_auth_redeems_refresh_token>).
