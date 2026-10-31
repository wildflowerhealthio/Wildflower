# Session Widening Routes

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_widening.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/session_widenings/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/session_widenings/get.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/session_widenings/approve.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/session_widenings/deny.rs}}

A [session widening](<../../Domain/Authorization Request/Session Widening Explanation.md>) has two sides on the wire. **The browser's**, on the limited page: `POST /oauth/authorize/{id}/ask-to-widen` files it, and `POST /oauth/session-widenings/{id}/poll` waits for the Owner and collects the wider session as the browser's cookie. Both answer only the browser session the request or widening was made in, read from its cookie. **The Owner's**, on the widening's card: `GET /authorization/session-widenings/{id}`, and its `/approve` and `/deny`, gated as the device page's are.

## `http::routes::oauth::session_widening`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_widening.rs self}}

### `AskedSessionWideningBody` and `SessionWideningStatusBody`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_widening.rs AskedSessionWideningBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_widening.rs SessionWideningStatusBody}}

### `handle_session_widening_ask`

The [start limit](<../Middleware Explanation.md>) layer wraps it as {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs AuthorizationStartRoute}}'s `AskToWidenSession`, which always defers the limit to the route: the ask spends from it only when it files a new widening.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_widening.rs handle_session_widening_ask}}

### `handle_session_widening_poll`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_widening.rs handle_session_widening_poll}}

## `http::routes::session_widenings`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/session_widenings/mod.rs self}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/session_widenings/mod.rs openapi_router}}

### `SessionWideningConsent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/session_widenings/get.rs SessionWideningConsent}}

### The handlers

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/session_widenings/get.rs handle_get_session_widening_consent}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/session_widenings/approve.rs ApproveSessionWideningBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/session_widenings/approve.rs handle_approve_session_widening}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/session_widenings/deny.rs handle_deny_session_widening}}
