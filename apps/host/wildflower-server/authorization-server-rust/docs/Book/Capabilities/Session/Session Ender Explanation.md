# Session Ender

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_ender.rs}}

The session ender is **logout**: a caller giving up the [access token](<../../Domain/Access Token Explanation.md>) it presented. The token is signed and carries its own expiry, so the caller forgetting it would leave any copy usable until then. Logout closes that window by putting the token's `jti` on the denylist the [token verifier](<Token Verifier Explanation.md>) checks. It does not revoke the browser session the token may name; that is [sign-out](<Browser Session Ender Explanation.md>).

It is built from the caller's verified claims, so **it can revoke nothing but the token that was presented**, and it takes no scope: anyone holding a valid token may end it. `POST /authorization/logout` builds one.

The test logs out through a [recording revocation port](<../Test Fixtures Explanation.md#session-ender>).

## `domain::capabilities::session::session_ender`

### `SessionEnder`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_ender.rs SessionEnder}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_ender.rs SessionEnder::new}}

#### `end`

The denylisting itself is [`revoke_session_token`](<../../Domain/Session Housekeeping Explanation.md#item-revoke_session_token>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_ender.rs SessionEnder::end tests="tests::end_revokes_only_the_presented_jti"}}
