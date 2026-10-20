# Session Housekeeping

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/session.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs}}

Two chores around a signed-in caller that never decide anything on their own. **Logout** denylists the [access token](<Access Token Explanation.md>) the caller presented, so a leaked copy of it can't be replayed afterwards. **Cookie use** moves a [browser session's](<Browser Session Explanation.md>) `last_seen_at`, so the Owner's list of browsers shows when each was last used; a throttle keeps a page load's burst of requests to one write.

Neither may get in the way of the request it rides on. A logout succeeds even when the denylist can't be written, and a request on a session cookie goes ahead whether or not its use is recorded.

## `domain::session`

### `revoke_session_token`

The token goes to the host's revocation store, through the [`Revocation`](<../Assembly/Ports and Adapters Explanation.md>) port. The [session ender](<../Capabilities/Session/Session Ender Explanation.md>) calls this, and only for a token that carries both a `jti` and an expiry. The tests stand a [recording fake](<Test Fixtures Explanation.md#session-housekeeping>) in for the store.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/session.rs revoke_session_token tests="tests::revokes_the_jti_with_the_logout_reason tests::swallows_a_store_failure_so_the_logout_still_proceeds"}}

## `domain::last_seen_throttle`

### `LastSeenThrottle`

One throttle is built at setup and shared by every request; the [browser session use recorder](<../Capabilities/Session/Browser Session Use Recorder Explanation.md>) asks it before each update.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs LastSeenThrottle}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs LastSeenThrottle::new}}

#### `admit`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs LastSeenThrottle::admit tests="tests::one_use_per_session_per_window_goes_on tests::the_map_holds_only_the_last_window_s_sessions"}}

#### `forget`

**A failed update doesn't cost the session its window.**

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs LastSeenThrottle::forget tests="tests::a_forgotten_session_goes_on_again"}}

#### `noted_sessions`

A test-only count, for the test that the map stays small.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs LastSeenThrottle::noted_sessions}}
