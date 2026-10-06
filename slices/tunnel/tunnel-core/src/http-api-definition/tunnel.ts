import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

/**
 * Tunnel state on the wire — mirrors the Rust `TunnelStateResponse`
 * (`slices/tunnel/tunnel-rust/.../routes/tunnel/wire_representations.rs`,
 * `#[serde(rename_all = "camelCase")]`): the tunnel's observed liveness.
 *
 * `status` is the liveness FSM position — one of `dialing`, `verified`, or
 * `unreachable`. Liveness is **verified, not optimistic**: `verified` only once
 * a `/health` probe through the public origin came back `pass` from this
 * device. `error` is set for `unreachable`.
 */
const TunnelStateViewSchema = Schema.Struct({
  status: Schema.Literal('dialing', 'verified', 'unreachable'),
  error: Schema.NullOr(Schema.String),
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
 * A just-started tunnel's snapshot — dialing, not yet verified. The single
 * canonical sample shared by the slice's tests, so the fixture doesn't drift
 * across packages when a field is added.
 */
const freshTunnelState: Schema.Schema.Type<typeof TunnelStateViewSchema> = {
  status: 'dialing',
  error: null,
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
