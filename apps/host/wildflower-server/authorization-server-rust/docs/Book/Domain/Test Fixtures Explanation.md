# Test Fixtures

The helpers the Domain part's unit tests build their values with, by the page whose tests use them. Most run on a fixed clock, so a test reads no wall time and can place a value either side of an expiry. A few fixtures are shared across the crate and live in the in-memory [test fake](<../Grant Store/Test Fake Explanation.md>); the rest sit in the test module they serve.

Several test modules name their helpers alike (`at`, `started`, `approval`); where a name repeats, the later ones are shown as plain excerpts with their doc comments kept.

## Scopes

`s` collects scope strings into the set [`grantable_scopes`](<Scopes Explanation.md#item-grantable_scopes>) takes, and `v` into the list [`with_alternate_canonical_forms`](<Scopes Explanation.md#item-with_alternate_canonical_forms>) takes.

{{#item slices/scopes/scopes-rust/src/smart.rs tests::s}}

{{#item slices/scopes/scopes-rust/src/smart.rs tests::v}}

{{#item slices/scopes/scopes-rust/src/scope/grant.rs tests::widened}}

## Access Token

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/mint.rs tests::shared_key}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/mint.rs tests::owner_args}}

## Client

The crate-wide client fixture is a public app named `<client_id> display name`, registered for the one redirect `https://example.com/cb`, allowed every grant type, trusted on first use, with the scopes the test passes. Its refresh policy sets no limit of its own, so a test about something else never runs into one.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs CEILING_ONLY_REFRESH_POLICY}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs owned_scopes}}

The presented-change tests judge a request at the fixture's redirect. Their property tests draw scope strings with no grammar characters, so coverage is plain equality and the properties read as set membership.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/presented_change.rs tests::redirect}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/presented_change.rs tests::judge}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client/presented_change.rs tests::arb_plain_scope}}

## Grant

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs tests::code_grant}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs tests::device_grant}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs tests::to_json}}

## Authorization Request

Every code-request fixture starts from the crate-wide arguments, overriding what its test is about.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs fixture_code_args}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/mod.rs tests::at}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/mod.rs tests::code_request}}

## Code Request

The code request's own tests keep the same clock, start a request with `started`, and approve it with `approval`.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/code/mod.rs tests::at}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/code/mod.rs tests::started}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/code/mod.rs tests::approval}}

The resolution tests present the fixture client's redirect.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/code/resolved.rs tests::redirect}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/code/resolved.rs tests::resolve}}

## Polled Requests

The shared tests in `polled` count in seconds, for the poll interval; the device and pairing tests count in minutes.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/polled.rs tests::at}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/polled.rs tests::device_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/polled.rs tests::approval}}

A device request's own tests:

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/device.rs tests::at}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/device.rs tests::started}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/device.rs tests::approval}}

A pairing's own tests:

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/pairing.rs tests::at}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/pairing.rs tests::started}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request/pairing.rs tests::approval}}

## Errors

RFC 6749 §4.1.2.1's grammar for an `error_description`, as a predicate.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorize_refusal.rs tests::is_error_description}}

## Refresh Token

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs tests::live_token}}

## Retention

Every row is placed relative to one fixed instant.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::now}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::family}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::token}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::code}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::session}}

The code request comes from the crate-wide fixture, moved to the status the test names.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs code_request}}

`seeded` puts one row of each kind on each side of its window: a family 91 days dead and one 89 days dead, a live family minted under the session `named`; requests and codes 8 days dead, 6 days dead, and live; sessions ended 25 hours ago, 23 hours ago, and 10 days ago (`named`).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::seeded}}

## Same-Device Sign-In Codes

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::SERVER_ORIGIN}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::destinations}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::allowed}}

## Session Housekeeping

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/session.rs tests::RecordingRevoker}}

## Source Guards

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::tests::scanned}}
