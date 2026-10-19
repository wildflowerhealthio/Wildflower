# Session Ender

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_ender.rs}}

The session ender is **logout**: a caller giving up the access token it presented. The token is a signed JWT with its own expiry, so the caller forgetting it would leave any copy usable until then. Logout closes that window by putting the token's `jti` on the denylist the [token verifier](<Token Verifier Explanation.md#verify>) checks.

It is built from the caller's verified claims, so **it can revoke nothing but the token that was presented**. It takes no scope: anyone holding a valid token may end it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_ender.rs SessionEnder}}

The ender holds the host's revocation port and the claims. `POST /authorization/logout` acquires it as `Authenticated<LiveSessionEnder>` (see the [session bindings](<../../Assembly/Session Bindings Explanation.md>)).

## Test fixtures

`RecordingRevoker` records every `jti` it is asked to revoke, and fails the test if asked to revoke a subject: logout never does.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_ender.rs tests::RecordingRevoker}}

`claims` builds claims for `client` with the `jti` and expiry the test chooses.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_ender.rs tests::claims}}

## `new`

Built from the revocation port and the caller's own claims.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_ender.rs SessionEnder::new}}

No unit test of its own; the test under [`end`](#end) builds three.

## `end`

**Denylist the presented token's `jti` until the token's own expiry**, when the token stops verifying anyway. A token with no `jti` or no `exp` has nothing to denylist, and ending it does nothing.

**Logout is best effort.** It returns nothing: [`revoke_session_token`](<../../Domain/Session Housekeeping Explanation.md#revoke_session_token>) logs a revocation-store failure and swallows it, so the logout's redirect is never blocked by it. It does not revoke the browser session the token may name; that is [sign-out](<Browser Session Ender Explanation.md>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_ender.rs SessionEnder::end}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_ender.rs tests::end_revokes_only_the_presented_jti}}

Of three logouts, only the one whose claims carry both a `jti` and an expiry revokes anything, and it revokes exactly that `jti`.

Exercised end to end by [`logout_revokes_the_presented_jti`](<../../Integration Tests/Revocation Explanation.md#logout_revokes_the_presented_jti>), [`access_logout_is_self_service_any_valid_bearer`](<../../Integration Tests/Scope Gating Explanation.md#access_logout_is_self_service_any_valid_bearer>) and [`logout_redirects_to_the_launcher_without_cookies`](<../../Integration Tests/Bearer Only Explanation.md#logout_redirects_to_the_launcher_without_cookies>).
