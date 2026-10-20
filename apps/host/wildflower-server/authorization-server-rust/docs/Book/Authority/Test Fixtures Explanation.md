# Test Fixtures

The helpers the Authority part's unit tests build their values with, by the page whose tests use them. They build on the crate-wide fixtures of the in-memory [test fake](<../Grant Store/Test Fake Explanation.md>), among them the shared [client](<../Domain/Test Fixtures Explanation.md#client>).

Two test modules name a helper alike (`redirect`, `SESSION_TTL`); the second of each is shown as a plain excerpt with its doc comment kept.

## Authenticated Client

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs tests::presented}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs tests::confidential}}

## Delegated Scopes

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::approvable}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::grant}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::device_prompt}}

## Standing Grant

`store_with_grant` stores its grant over the shared {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs code_grant}} fixture.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs tests::redirect}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs tests::store_with_grant}}

## Redemption

`authenticated` registers its app through the shared {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs authenticated_public_client}} fixture.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::authenticated}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::REDIRECT}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::redirect keep-docs}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::VERIFIER}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::issued_code}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::reason}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::live_family}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs tests::live_family_under}}

## Same-Device Sign-In

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs tests::SESSION_TTL}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs tests::owner_grant}}

## Browser Pairing

`approved_pairing` approves its request through the shared {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs approve_stored}} fixture, as the Owner would on the device page.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs tests::SESSION_TTL keep-docs}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs tests::pairing}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs tests::stored}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs tests::approved_pairing}}
