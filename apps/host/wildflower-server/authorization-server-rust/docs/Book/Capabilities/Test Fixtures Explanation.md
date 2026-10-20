# Test Fixtures

The helpers the Capabilities part's unit tests build their capabilities and values with, by the page whose tests use them. They build on the in-memory [test fake](<../Grant Store/Test Fake Explanation.md>) and its shared fixtures (a client, a code request, a device request, a browser pairing, a seeded browser session, a recording republish port); the rest sit in the test module they serve.

Several test modules name their helpers alike (`SERVER_ORIGIN`, `authenticated`, `claims`); where a name repeats, the later ones are shown as plain excerpts with their doc comments kept.

## Consents

Every decision goes through `decider`, over a clone of the store the test arranges and reads back.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::decider}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_code}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_device_consent}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::deny_device_consent}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approved}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::owner_grant}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approver_grant_with}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::live_code_store}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::resource_scope_code_store}}

## Grants

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs tests::SubjectsRevoked}}

## Clients

The tests name the two essential apps by the crate's own ids.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::HOST}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::BROWSER_SESSION_CLIENT}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::disabler_with}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::at}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::stored}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::NOW}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::disable}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::enable}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::IDS}}

## Launch Contexts

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs tests::consume}}

## Code Authorization Starter

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::CHALLENGE}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::SERVER_ORIGIN}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::REQUESTING_SID}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::SAME_DEVICE_SESSION_GRANT}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::ids}}

`starter` stores the requesting session as a paired session holding only `wildflower/launch`. The request's `browser_session_grant` is what the starter checks for a shortfall; the stored session is what the approval bounds the code by. The two differ on purpose, so a test can see a code narrowed to the stored session.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::starter}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::registered_app_starter}}

The launch tests plant and spend launches in the starter's own store.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::StoredLaunches}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::StoredLaunches::mint}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::StoredLaunches::mint_for_server_launcher}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::StoredLaunches::consume}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::launch_contexts_of}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::launch_refusal_description}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::launch_refusal_page}}

The limited-page and standing-grant tests use a store where a standing grant covers the request, so without a shortfall it would take the fast path.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::covered_app_store}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::COVERED_SCOPES}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::park_for_the_limited_page}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::grant_last_used_at}}

## Authorization Status Reader

The requests polled are the fake store's code and device requests.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs tests::session}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs tests::requester}}

## Session Shortfall

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs tests::code_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs tests::awaiting_limited_page}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs tests::status_of}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs tests::browser_session}}

## Device Authorizer

The device authorizer, the token exchanger and the client token revoker each authenticate their fixture app through the fake store's public-client fixture.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs tests::device_page}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs tests::authenticated}}

## Browser Pairing

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs tests::SERVER_ORIGIN keep-docs}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs tests::NEXT}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs tests::pairing}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs tests::approve}}

## Same-Device Sign-In

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs tests::SERVER_ORIGIN keep-docs}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs tests::OWNER_SCOPES}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs tests::sign_in_over}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs tests::sign_in_with_a_code}}

## Token Exchanger

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs tests::VERIFIER}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs tests::SERVER_ORIGIN keep-docs}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs tests::exchanger}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs tests::authenticated keep-docs}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs tests::issue_code}}

## Client Token Revoker

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::SERVER_ORIGIN keep-docs}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::revoker}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::authenticated keep-docs}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::plant_family}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::family_expires_at}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::access_token}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/client_token_revoker.rs tests::is_jti_denylisted}}

## Token Verifier

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::FakeRevocation}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::ORIGIN}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::OTHER_ORIGIN}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::store_with_key}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::verifier}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::mint}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::mint_under_session}}

## Session Reader

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs tests::claims}}

## Session Ender

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_ender.rs tests::RecordingRevoker}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_ender.rs tests::claims keep-docs}}

## Browser Session Ender

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_ender.rs tests::claims keep-docs}}

## Browser Session Use Recorder

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs tests::claims keep-docs}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs tests::last_seen}}
