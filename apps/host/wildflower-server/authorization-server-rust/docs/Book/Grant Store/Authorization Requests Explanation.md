# Authorization Requests

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs}}

The `authorization_requests` table holds every [authorization request](<../Domain/Authorization Request Explanation.md>), of every kind, from the moment it starts until the retention sweep removes it. A request's row is the shared record that the app polling, the browser waiting and the Owner deciding all read and write, so **the rule this table keeps is that a decision lands once**: a transition is written only over the row as it was read. That guarded replace is explained, with the races it settles, on the domain page: [The guarded replace: first decision wins](<../Domain/Authorization Request Explanation.md#the-guarded-replace-first-decision-wins>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs AuthorizationRequestsTx}}

## `authorization_request_by_id`

The request with this id, whatever its status, or `None`. A device-flow request's id is its `device_code`; any other request's is an internal UUID. The app polling, the waiting page and the consent card all find their request this way.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs AuthorizationRequestsTx::authorization_request_by_id}}

The SQLite side: [`authorization_request_by_id`](<../Persistence/Authorization Requests Explanation.md#authorization_request_by_id>).

## `authorization_request_by_user_code`

Any request bearing this `user_code`, **whatever its status**. Its one production caller is minting a fresh user code: a candidate is taken only if no request, live or finished, already bears it, so a stale denied or expired row can never shadow the new request at the consent-side lookup.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs AuthorizationRequestsTx::authorization_request_by_user_code}}

The SQLite side: [`authorization_request_by_user_code`](<../Persistence/Authorization Requests Explanation.md#authorization_request_by_user_code>).

## `pending_authorization_request_by_user_code`

The **pending** request for this `user_code`, or `None`: what the Owner's device page looks up when they type a code. The status filter is the point. A finished request holding the same code never answers for a live one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs AuthorizationRequestsTx::pending_authorization_request_by_user_code}}

The SQLite side: [`pending_authorization_request_by_user_code`](<../Persistence/Authorization Requests Explanation.md#pending_authorization_request_by_user_code>).

## `newest_pending_consent`

The newest request still waiting on the Owner at `now`, as a [`NewestPendingConsent`](<../Domain/Pending Consent Explanation.md>): pending, unexpired, and, for a code request, past its browser's limited page. A disabled app's request is skipped; an app with no registration yet is kept, with no registered name. This is the one request the host notifies about and opens for the Owner.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs AuthorizationRequestsTx::newest_pending_consent}}

The SQLite side: [`newest_pending_consent`](<../Persistence/Authorization Requests Explanation.md#newest_pending_consent>).

## `insert_authorization_request`

Record a request that has just started. **Only one pending request may hold a given `user_code`**; the insert fails rather than let a second live one in. A pending row that holds this request's `user_code` but had expired by the time this request started is cleared first, since it occupies that slot; any other expired row is left for the retention sweep.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs AuthorizationRequestsTx::insert_authorization_request}}

The SQLite side: [`insert_authorization_request`](<../Persistence/Authorization Requests Explanation.md#insert_authorization_request>).

## `replace_authorization_request`

Write a transition's request over its row, **only if the row is still in the phase the request was read in**: its status, and for a code request whether the limited page was acknowledged. `true` means this write won; `false` means another transition moved the row first, or it is gone, and nothing changed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs AuthorizationRequestsTx::replace_authorization_request}}

The SQLite side: [`replace_authorization_request`](<../Persistence/Authorization Requests Explanation.md#replace_authorization_request>).

## `write_transition`

The one-line way a flow writes a transition: a refused transition and a lost race both come back `false`. It is shown and explained under [the guarded replace](<../Domain/Authorization Request Explanation.md#the-guarded-replace-first-decision-wins>):
{{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs write_transition}}.

## `delete_authorization_requests_expired_before`

The retention sweep's step for requests: delete every request whose `expires_at` fell before `cutoff`, whatever its status, and count them. [`purge_expired`](<../Domain/Retention Explanation.md#purge_expired>) passes `now` less the authorization retention, so an expired request is kept a while as an audit buffer before it goes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs AuthorizationRequestsTx::delete_authorization_requests_expired_before}}

The SQLite side: [`delete_authorization_requests_expired_before`](<../Persistence/Authorization Requests Explanation.md#delete_authorization_requests_expired_before>).
