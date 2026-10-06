import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

/**
 * Tunnel state on the wire — mirrors the Rust `TunnelStateResponse`
 * (`slices/tunnel/tunnel-rust/.../routes/tunnel/wire_representations.rs`,
 * `#[serde(rename_all = "camelCase")]`): the tunnel's observed liveness and
 * the public host the relay serves the server at. The relay settings live in
 * the server's record and only the base changes them, so none appear here.
 *
 * `status` is the authoritative liveness FSM position — one of `off`,
 * `dialing`, `verified`, or `unreachable`. Liveness is **verified, not
 * optimistic**: `servedOrigin` resolves to `https://{publicHost}` **only**
 * while `status === 'verified'` (a `/health` probe through the public origin
 * came back `pass` from this device), otherwise the loopback fallback.
 * `running` is the coarse "a supervisor is attempting" view (`true` for
 * `dialing`/`verified`/`unreachable`). `error` is set for `unreachable`.
 *
 * `dialAttempts` counts dial attempts since the server started — a counter
 * that climbs with no recovery flags a permanent misconfiguration.
 *
 * `dialAttempts` is `i64` on the Rust side; as a monotonic counter it stays
 * well under `2^53`. `Schema.Int` (not `Schema.Number`) keeps the OpenAPI type
 * `integer`, matching utoipa's `i64` so the spec-drift contract test agrees on
 * the wire kind.
 */
const TunnelStateViewSchema = Schema.Struct({
  publicHost: Schema.String,
  status: Schema.Literal('off', 'dialing', 'verified', 'unreachable'),
  running: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  dialAttempts: Schema.Int,
  servedOrigin: Schema.String,
})

/**
 * `403` body — the caller authenticated, but their token doesn't cover the
 * `/tunnel` scope (`wildflower/TunnelSettings.r`). Matches the shared Rust
 * `InsufficientScopeBody` (`scope-capabilities-rust`); `missingScopes` names
 * the scopes the caller must additionally hold.
 */
const InsufficientScopeSchema = Schema.Struct({
  error: Schema.Literal('InsufficientScope'),
  missingScopes: Schema.Array(Schema.String),
})

/**
 * A just-started tunnel's snapshot — dialing, not yet verified, so the server
 * is served at its loopback fallback. The single canonical sample shared by
 * the slice's tests, so the fixture doesn't drift across packages when a field
 * is added.
 */
const freshTunnelState: Schema.Schema.Type<typeof TunnelStateViewSchema> = {
  publicHost: 'ruth.relay.wildflowerhealth.io',
  status: 'dialing',
  running: true,
  error: null,
  dialAttempts: 0,
  servedOrigin: 'http://127.0.0.1:8080',
}

/**
 * Tunnel-state endpoint. The group carries no middleware — auth is applied by
 * the host. In the Tauri app the Rust server gates `/tunnel` behind the
 * gatekeeper Owner check; the TS client layer still attaches the bearer (see
 * `tunnel-react/src/client/tunnel-client.ts`).
 *
 * `GetTunnel` is scope-gated on the Rust side by `wildflower/TunnelSettings.r`,
 * returning a `403 InsufficientScope` when the token doesn't cover it. There is
 * no write: only the base changes a server's tunnel.
 */
const httpApiGroup = HttpApiGroup.make('tunnel', { topLevel: false }).add(
  HttpApiEndpoint.get('GetTunnel', '/tunnel')
    .addSuccess(TunnelStateViewSchema)
    .addError(InsufficientScopeSchema, { status: 403 })
)

export { freshTunnelState, httpApiGroup, InsufficientScopeSchema, TunnelStateViewSchema }
