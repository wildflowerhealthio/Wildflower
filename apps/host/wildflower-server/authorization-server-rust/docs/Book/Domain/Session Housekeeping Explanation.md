# Session Housekeeping

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/session.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs}}

Two chores around a signed-in caller's session that never decide anything on their own. **Logout** denylists the token the caller presented, so a leaked copy of it can't be replayed afterwards. **Cookie use** moves a [browser session's](<Browser Session Explanation.md>) `last_seen_at`, so the Owner's list of browsers shows when each was last used; a throttle keeps a page load's burst of requests to one write.

Neither may get in the way of the request it rides on. A logout succeeds even when the denylist can't be written, and a request on a session cookie goes ahead whether or not its use is recorded.

## `revoke_session_token`

**Logging out denylists the presented token's `jti` until the token would have expired anyway**, recorded with the reason `logout`. The caller's token was already verified by the gate in front of `POST /authorization/logout`, so its `jti` and expiry are trusted. It goes through the [`Revocation`](<../Assembly/Ports and Adapters Explanation.md>) port, the host's revocation store.

**Best-effort by design.** The client has already forgotten the token by the time it logs out, so a failure to write the denylist (the `jti` already revoked, the store briefly unavailable) is logged and swallowed: the logout never fails because of it. The [session ender](<../Capabilities/Session/Session Ender Explanation.md>) calls this, and only for a token that carries both a `jti` and an expiry.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/session.rs revoke_session_token}}

### What it looks like

The tests use a fake revocation store that records each call and fails on request.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/session.rs tests::RecordingRevoker}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/session.rs tests::revokes_the_jti_with_the_logout_reason}}

The store is asked once, for the token's `jti`, until its expiry, with the reason `logout`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/session.rs tests::swallows_a_store_failure_so_the_logout_still_proceeds}}

A failing store is still asked once, and the failure doesn't escape.

Exercised end to end by [`logout_revokes_the_presented_jti`](<../Integration Tests/Revocation Explanation.md#logout_revokes_the_presented_jti>).

## `LastSeenThrottle`

**A session's cookie use moves `last_seen_at` at most once every [`LAST_SEEN_RESOLUTION`](<Browser Session Explanation.md#last_seen_resolution>)** (five minutes). A page load sends many requests on one cookie. The throttle is the in-memory gate in front of the conditional update: it lets one use per session through per window, and the rest write nothing. The update's own guard (it moves `last_seen_at` only if it hasn't moved within the window) holds the same limit across a restart, which empties the throttle.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs LastSeenThrottle}}

It holds, per `sid`, when that session's use was last let through. One throttle is built at setup and shared by every request; the [browser session use recorder](<../Capabilities/Session/Browser Session Use Recorder Explanation.md>) asks it before each update. `new` starts empty.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs LastSeenThrottle::new}}

## `admit`

**Whether this use goes on to the update**: none of the session's uses was let through in the window before `now`. A use that goes on is noted at `now`, and every note older than the window is dropped, so the map holds only the sessions let through within the last window. That is at most the live sessions, since a `sid` reaches here only from a token the gates accepted.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs LastSeenThrottle::admit}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs tests::one_use_per_session_per_window_goes_on}}

A session's first use goes on and its next, four minutes later, doesn't; another session has its own window; once a full window has passed the session's use goes on again, and the next one a second later doesn't.

The next test counts the notes with a test-only helper:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs LastSeenThrottle::noted_sessions}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs tests::the_map_holds_only_the_last_window_s_sessions}}

Three sessions are noted; a fourth let through six minutes later drops all three, leaving one note.

## `forget`

**A failed update doesn't cost the session its window.** When the update a use was let through for fails, the recorder drops the session's note, so the session's next use goes on and tries again.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs LastSeenThrottle::forget}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs tests::a_forgotten_session_goes_on_again}}

After the note is forgotten, a use a minute later, inside the window, goes on.
