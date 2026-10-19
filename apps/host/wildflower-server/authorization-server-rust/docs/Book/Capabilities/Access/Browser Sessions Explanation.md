# Browser Sessions

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs}}

Every browser the server has signed in holds a [browser session](<../../Domain/Browser Session Explanation.md>): the Owner's own, from a same-device sign-in, or an approved browser's, from a pairing. The Owner's "Browsers" list shows the live ones and signs one out. **Revoking a session ends everything minted under it**: the token verifier refuses a token whose `sid` names a revoked session, and refresh redemption refuses a family whose `sid` does. Listing takes `wildflower/BrowserSession.r`; revoking takes `wildflower/BrowserSession.d`.

## `browser_sessions_reader_scopes`

The gate on the list: `wildflower/BrowserSession.r`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs browser_sessions_reader_scopes}}

## `browser_sessions_revoker_scopes`

The gate on signing a browser out: `wildflower/BrowserSession.d`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs browser_sessions_revoker_scopes}}

## `BrowserSessionView`

A session as the list shows it, and whether it is the caller's own: the session the caller's token was minted under.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionView}}

## `BrowserSessionsReader`

Read access to the live sessions, behind `GET /authorization/browser-sessions`. It holds only the store.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsReader}}

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsReader::new BrowserSessionsRevoker::new}}

## `list_live`

Every session live at `now`, neither revoked nor expired, newest first, each marked by whether the caller's token names it. A caller whose token was minted under no session holds none of them.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsReader::list_live}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs tests::the_list_holds_the_live_sessions_and_marks_the_caller_s}}

Of four sessions, the expired one and the revoked one are left out; the caller's is first, marked held, and the older one follows unmarked. Listed for a caller under no session, none is marked.

Exercised end to end by [`the_browsers_list_shows_live_sessions_and_revokes_one`](<../../Integration Tests/Browser Sessions Explanation.md#the_browsers_list_shows_live_sessions_and_revokes_one>).

## `BrowserSessionsRevoker`

Sign a browser out, behind `DELETE /authorization/browser-sessions/{sid}`. It holds only the store. **Revoking the caller's own session is allowed**: it signs that browser out.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsRevoker}}

## `revoke`

Stamp the session revoked at `now`, in one write scope. Only a session not yet revoked is stamped, so a second revoke, or a `sid` no session ever had, is `BrowserSessionNotFound`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsRevoker::revoke}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs tests::revoke_ends_a_standing_session_and_misses_anything_else}}

The first revoke succeeds and the session reads as revoked; revoking it again, or an unknown `sid`, is `BrowserSessionNotFound`.

Exercised end to end by [`the_browsers_list_shows_live_sessions_and_revokes_one`](<../../Integration Tests/Browser Sessions Explanation.md#the_browsers_list_shows_live_sessions_and_revokes_one>), [`revoking_the_caller_s_own_session_signs_it_out`](<../../Integration Tests/Browser Sessions Explanation.md#revoking_the_caller_s_own_session_signs_it_out>), [`an_app_authorized_in_a_session_is_ended_with_it`](<../../Integration Tests/Browser Sessions Explanation.md#an_app_authorized_in_a_session_is_ended_with_it>), [`approving_a_request_whose_session_was_revoked_denies_it`](<../../Integration Tests/Browser Sessions Explanation.md#approving_a_request_whose_session_was_revoked_denies_it>) and [`the_browsers_routes_are_scope_gated`](<../../Integration Tests/Browser Sessions Explanation.md#the_browsers_routes_are_scope_gated>).
