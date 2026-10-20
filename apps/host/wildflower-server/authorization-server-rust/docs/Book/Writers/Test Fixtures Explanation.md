# Test Fixtures

The helpers the Writers part's unit tests build their values with, by the page whose tests use them. They build on the crate-wide fixtures of the in-memory [test fake](<../Grant Store/Test Fake Explanation.md>), among them the shared [client](<../Domain/Test Fixtures Explanation.md#client>).

## Request Approver

`pending_code_request_in_session` parks its request from the crate-wide {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs fixture_code_args}}. `approve` approves on the Owner's authority, a proof built by the test fake's {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs delegated_scopes}}.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::pending_code_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::pending_code_request_in_session}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::stored}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::approve}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::standing_grant_coverage}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::grant_last_used_at}}

## Grant Recorder

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::redirect}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::widened}}

## Refresh Family Writer

`validated` runs the real [`validate`](<../Authority/Redemption Explanation.md#item-ValidatedRefreshToken--validate>), in the read scope the token exchange would.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs tests::validated}}

## Access Token Minter

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs tests::minter}}
