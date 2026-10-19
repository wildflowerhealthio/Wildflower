# Session Reader

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs}}

The session reader is a caller reading back **its own** session: the scopes the token it presented carries, and, for a token minted under a browser session, when that session ends. Every answer comes from the caller's verified claims or from the one browser session their `sid` names, so the read discloses nothing about anyone else, and it needs no scope.

That matters for who calls it. The device-login screen reads the session's real scopes to seed its scope picker, and the server's own pages read the browser session's expiry to show how long the browser stays signed in. A caller that has just been refused for a missing scope is exactly the one that needs to read what it does hold.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs SessionReader}}

The reader holds the store and the claims the session gate verified. The `Authenticated<LiveSessionReader>` extractor builds it for `GET /authorization/session`, and for the browsers list, which reads the caller's `sid` to mark the caller's own browser (see the [session bindings](<../../Assembly/Session Bindings Explanation.md>)).

## Test fixtures

`claims` builds verified claims for `client`, holding `openid wildflower/Grant.r`, under the `sid` the test chooses or none.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs tests::claims}}

## `new`

Built from a store handle and the caller's own claims, nothing else.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs SessionReader::new}}

No unit test of its own; the test under [`browser_session_expires_at`](#browser_session_expires_at) builds one.

## `sid`

The browser session the caller's token was minted under, or `None` for a token minted under no browser session. It reads the claim; it does not check the session exists.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs SessionReader::sid}}

Asserted alongside [`browser_session_expires_at`](#browser_session_expires_at).

## `scopes`

The scopes the token actually holds: its `scope` claim split on whitespace, or nothing when the token carries no `scope` claim. These are the token's scopes, not the session's or the grant's, so a narrowed token reads back narrowed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs SessionReader::scopes}}

Asserted alongside [`browser_session_expires_at`](#browser_session_expires_at). Exercised end to end by [`access_session_reports_the_callers_own_scopes_without_an_admin_scope`](<../../Integration Tests/Scope Gating Explanation.md#access_session_reports_the_callers_own_scopes_without_an_admin_scope>) and [`access_session_without_a_token_is_401_not_an_empty_scope_list`](<../../Integration Tests/Scope Gating Explanation.md#access_session_without_a_token_is_401_not_an_empty_scope_list>).

## `browser_session_expires_at`

**When the browser the caller is using stops being signed in.** The reader looks up the session the `sid` names and returns its `expires_at`. A token with no `sid`, or a `sid` that names no session row, has no expiry to report and reads `None`. The read does not check revocation: the session gate's [`verify`](<Token Verifier Explanation.md#verify>) has already refused a token whose session is revoked. A store failure is an infrastructure error.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs SessionReader::browser_session_expires_at}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs tests::the_browser_session_expiry_is_the_named_session_s}}

Claims under a stored Owner session read back that session's `expires_at`, its `sid`, and the two scopes of the claim; claims with no `sid`, or a `sid` naming no session, read no expiry.

Exercised end to end by [`the_session_read_answers_the_browser_session_s_expiry`](<../../Integration Tests/Browser Sessions Explanation.md#the_session_read_answers_the_browser_session_s_expiry>).
