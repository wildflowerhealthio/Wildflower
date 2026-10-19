# Authorization Status Reader

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs}}

When an app's code request can't be decided in the browser that made it, the browser waits on the wait page. The page polls `GET /oauth/authorize/{id}` until the Owner decides, then follows the answer back to the app: with a code, with `access_denied`, or nowhere if the request expired. The status reader is that poll. **Its only power is this one read**, so the handler holding it can do nothing else with the store.

An approved request's status carries its code, so **the poll answers only a browser entitled to see it**: the [browser session](<../../Domain/Browser Session Explanation.md>) the request was made in, or a session that could decide the request on the consent card anyway. Holding the request id is not enough. Anyone else, with another session or with none, gets the same not-found as an id that doesn't exist, so the answer doesn't even say whether the id is real.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs AuthorizationStatusReader}}

`new` wraps a store handle lifted from the state.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs AuthorizationStatusReader::new}}

## `PollingBrowserSession`

The browser asking: the `sid` of the session its cookie carries, and the grant that session's verified token holds. The route builds it from the `__Host-browser_session` cookie; a browser with no cookie, or whose session has ended, polls with none.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs PollingBrowserSession}}

**A session may read a request when the request was made in it, or when its grant covers the deciding scopes.** The request remembers its session as the [code request's `sid`](<../../Domain/Authorization Request Explanation.md#the-code-request>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs PollingBrowserSession::may_read}}

## `any_request_status_scopes`

The scopes that open any code request's status: `wildflower/AuthorizationRequest.r` and `wildflower/AuthorizationRequest.u`, the ones that load a request on the consent card and decide it there. **Reading the status gives such a session nothing new.** It could approve the request itself, and the code in the status is bound by PKCE to the app that asked, so only that app can redeem it. This is what lets the Owner's wait page keep answering after the Owner signs in in the same browser, under a new session.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs any_request_status_scopes}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs tests::any_request_status_scopes_are_authorization_request_read_and_update}}

The scopes render as exactly the consent card's read and update scopes on authorization requests.

## Test fixtures

`session` builds a polling session with a `sid` and the scopes its grant holds, and `requester` is the session the shared fixture requests were made in, holding nothing. The requests themselves come from the fake store's `code_request` and `device_request` fixtures.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs tests::session}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs tests::requester}}

## `AuthorizationStatusView`

Where a polled request stands. A denial carries the app's `redirect_uri` and `state`, and an approval carries those and the code; the route builds the app's callback from them, `error=access_denied` for a denial and the code for an approval.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs AuthorizationStatusView}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs AuthorizationStatusError}}

`NotFound` is the route's `404`. `ApprovedWithoutCode` breaks an invariant (approving a code request issues its code in the same write), and the route answers it `500 server_error`.

## `status`

The poll opens a **read** scope and looks the request up by id. **A request the poller may not read, a request that isn't a code request, and any request polled without a session are all `NotFound`**, the same as an unknown id. A device request and a browser pairing each have their own poll, keyed by their own secret.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs AuthorizationStatusReader::status}}

Then the status maps to the view:

| Stored status                  | The view                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `Pending`, before `expires_at` | `Pending`: keep polling.                                                                                                     |
| `Pending`, past `expires_at`   | `Expired`. [Expiry is never stored](<../../Domain/Authorization Request Explanation.md#is_expired_at>); the poll derives it. |
| `Denied`                       | `Denied`, with the app's callback details.                                                                                   |
| `Approved`                     | `Approved`, with the code issued for the request.                                                                            |
| `Claimed`                      | `Expired`.                                                                                                                   |

Only a pending request expires here. An approved request answers with its code whatever the time; the code's own expiry is checked when the app redeems it.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs tests::status_reports_each_state_and_expires_stale_pending_requests}}

Polled by the session that made them, a live pending request reads `Pending`, one past its expiry reads `Expired`, a denied one reads `Denied`, an approved one reads `Approved` with the callback and the code issued for it, and an unknown id is `NotFound`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs tests::status_answers_the_requesting_session_and_sessions_that_decide_consents}}

The requesting session and a session holding both deciding scopes read the parked request. Another session holding nothing, a session holding only `AuthorizationRequest.r`, one holding only `AuthorizationRequest.u`, and no session at all get `NotFound`. A device request is `NotFound` to everyone, even a session holding both scopes.

Exercised end to end by [`a_leaked_request_id_collects_nothing`](<../../Integration Tests/Session Required Explanation.md#a_leaked_request_id_collects_nothing>), [`the_wait_page_reads_the_status_after_the_owner_signs_in_in_the_same_browser`](<../../Integration Tests/Session Required Explanation.md#the_wait_page_reads_the_status_after_the_owner_signs_in_in_the_same_browser>), [`approving_on_the_owner_s_bearer_sends_the_code_to_the_client_and_settles_the_wait_page`](<../../Integration Tests/Consent Card Explanation.md#approving_on_the_owner_s_bearer_sends_the_code_to_the_client_and_settles_the_wait_page>), [`denying_sends_access_denied_to_the_client_and_settles_the_wait_page`](<../../Integration Tests/Consent Card Explanation.md#denying_sends_access_denied_to_the_client_and_settles_the_wait_page>) and [`pending_authorization_status_is_cache_suppressed`](<../../Integration Tests/Cache Suppression Explanation.md#pending_authorization_status_is_cache_suppressed>).
