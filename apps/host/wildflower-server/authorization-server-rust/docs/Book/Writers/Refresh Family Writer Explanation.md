# Refresh Family Writer

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs}}

A refresh token is a standing credential: with it, an app gets fresh access tokens long after the person who approved it has left. Refresh tokens come in [families](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>). A family starts with one token when a grant is redeemed, and each refresh consumes the token presented and adds its successor, so one token in a family is live at a time. The family holds what every token in it is good for: the app, the scopes, the patient, the deadline.

The refresh-family writer starts families and rotates tokens. **Both take a [redemption proof](<../Authority/Redemption Explanation.md>)**: a [`GrantRedemption`](<../Authority/Redemption Explanation.md#item-GrantRedemption>) to start a family, so a refresh token is only ever minted for scopes a consumed code or a claimed device request recorded; a [`ValidatedRefreshToken`](<../Authority/Redemption Explanation.md#item-ValidatedRefreshToken>) to rotate one, so a token is only ever rotated within a family that validated for the app presenting it.

A rotation is also a use. **An app refreshing is its browser session in use**, so the session's `last_seen_at` moves, and **a device refreshing is its pairing in use**, so the [device grant](<../Domain/Grant Explanation.md#item-DeviceGrant>) that earned the family is stamped used. A code grant isn't stamped on a refresh: it is used when it stands in for the Owner at `/oauth/authorize`, which the request approver stamps.

## `domain::capabilities::writers::refresh_family_writer`

The rotation tests validate their tokens with the [refresh-family fixture](<Test Fixtures Explanation.md#refresh-family-writer>), and start from a redeemed code built by the test fake's {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs redeemed_code}}.

### `RefreshFamilyWriter`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter}}

#### `within`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter::within}}

#### `start_family`

**A family comes only with `offline_access`**: the token exchange asks the redemption's [`is_refresh_token_earned`](<../Authority/Redemption Explanation.md#item-GrantRedemption--is_refresh_token_earned>) first, and the writer itself doesn't ask. The family's deadline is [`REFRESH_TOKEN_FAMILY_TTL`](<../Domain/Refresh Token Explanation.md#item-REFRESH_TOKEN_FAMILY_TTL>) from now, and rotation never extends it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter::start_family tests="tests::only_offline_access_earns_a_refresh_token tests::start_family_records_the_redemption"}}

#### `rotate`

The consume is the single-use claim ([`consume_refresh_token`](<../Domain/Refresh Token Explanation.md#item-consume_refresh_token>)).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter::rotate tests="tests::rotate_consumes_then_replay_expires_the_family tests::rotate_marks_the_family_s_browser_session_seen tests::rotate_stamps_the_device_grant_that_earned_the_family"}}

End to end, the [Device Code](<../Integration Tests/Device Code Explanation.md>) and [Client Auth](<../Integration Tests/Client Auth Explanation.md>) tests hold rotation at `/oauth/token`, and that a device approval's grant is linked to the family it earns.
