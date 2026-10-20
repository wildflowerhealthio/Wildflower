# Test Fixtures

The helpers the HTTP part's unit tests share within a file, one section per page that uses them.

## Browser Session Cookie

The tests mint real tokens, signed with a real key, and verify them against the fake store.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs tests::mint}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs tests::mint_scoped}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs tests::cookie_headers}}

## Errors and Wire Shapes

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs tests::stamped_refusal}}

## Middleware

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs tests::exempt}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs tests::bearer}}

## Authorization Pages

The tests serve a fake build, laid out as Vite lays it out, with a launcher on another origin.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::PAGES}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::launcher_base}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::get}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::body}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::header_of}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::assert_locked_down}}

## Token Endpoint

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs tests::headers_with_content_type}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::presented}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::basic_authorization}}
