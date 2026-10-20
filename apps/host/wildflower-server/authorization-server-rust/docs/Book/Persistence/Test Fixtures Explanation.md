# Test Fixtures

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/test_support.rs}}

The generators and helpers the adapter's tests share, by the page whose tests use them. **Every test runs against a real, freshly migrated SQLite database**, in memory, so what the tests hold is the SQL itself: its guards, its constraints, its column mappings. The property tests write a generated row and read it back unchanged, so their generators draw only values that survive that trip.

## Shared generators

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/test_support.rs arb_timestamp}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/test_support.rs arb_opt_timestamp}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/test_support.rs arb_url}}

## SQLite Grant Store

The migration tests drive a database to the version an install was at, and read columns back with raw SQL.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::MigrationsThrough}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::MigrationsThroughOnly0009}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::Name}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::OptionalName}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::column_for_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::allowed_scopes_of}}

## Clients

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::arb_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::seeded_client_ids}}

## Browser Sessions

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs tests::store}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs tests::family}}

## Authorization Requests

The round trip draws a request of any flow in any state; the other tests build pending requests and plant them through the store.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::arb_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::arb_approval}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::arb_polled_state}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::arb_authorization_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::insert_any}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::device_request_at}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::device_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::code_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::insert_device}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::insert_code}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::stored}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::execute_unchecked}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::newest}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::is_awaiting_owner::awaiting}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::is_awaiting_owner::oauth}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs tests::is_awaiting_owner::device}}

## Launch Contexts

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs tests::store}}

## Grants

`revoke_grant` runs the same three statements as the real revoke, but not in the same shape: the real revoke reports the miss inside the scope, so a miss expires nothing, and it revokes the app's access tokens before it opens the scope. `upsert_code_grant` and `upsert_device_grant` follow the grant recorder, minus the code grant's registration write.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs tests::SharedGrantFields}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs tests::arb_shared}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs tests::arb_grant}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs tests::read}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs tests::revoke_grant}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/authorization_code.rs tests::upsert_code_grant}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/authorization_code.rs tests::read}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/device.rs tests::upsert_device_grant}}

## Authorization Codes

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_codes.rs tests::arb_authorization_code}}

## Refresh Tokens

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs arb_family}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs arb_token_in_family}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs seed_family_with_token}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs sample_family}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs sample_token}}

## Signing Keys

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs tests::arb_signing_key}}
