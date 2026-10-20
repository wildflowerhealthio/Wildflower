# Authorization Status Reader

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs}}

When an app's [code request](<../../Domain/Authorization Request/Code Request Explanation.md>) can't be decided in the browser that made it, the browser waits on the wait page. The page polls `GET /oauth/authorize/{id}` until the request is decided, then follows the answer back to the app: with a code, with `access_denied`, or nowhere if the request expired. The status reader is that poll, and **its only power is this one read**.

An approved request's status carries its code, so **the poll answers only a browser entitled to see it**: the [browser session](<../../Domain/Browser Session Explanation.md>) the request was made in, or a session that could decide the request on the consent card anyway. Holding the request id is not enough. Reading the status gives a deciding session nothing new, since the code is bound by PKCE to the app that asked, and it lets the Owner's wait page keep answering after the Owner signs in again in the same browser, under a new session.

The tests poll the fake store's code and device requests as [the requesting session or another](<../Test Fixtures Explanation.md#authorization-status-reader>).

## `domain::capabilities::oauth::authorization_status_reader`

### `any_request_status_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs any_request_status_scopes tests="tests::any_request_status_scopes_are_authorization_request_read_and_update"}}

### `PollingBrowserSession`

The route builds it from the browser's session cookie; a browser with no cookie, or whose session has ended, polls with none.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs PollingBrowserSession}}

#### `can_read`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs PollingBrowserSession::can_read}}

### `AuthorizationStatusView`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs AuthorizationStatusView}}

### `AuthorizationStatusError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs AuthorizationStatusError}}

### `AuthorizationStatusReader`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs AuthorizationStatusReader}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs AuthorizationStatusReader::new}}

#### `status`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs AuthorizationStatusReader::status tests="tests::status_reports_each_state_and_expires_stale_pending_requests tests::status_answers_the_requesting_session_and_sessions_that_decide_consents tests::a_request_on_its_limited_page_reads_as_pending"}}
