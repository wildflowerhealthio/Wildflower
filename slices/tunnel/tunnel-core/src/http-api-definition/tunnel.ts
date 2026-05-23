import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

/**
 * Merged tunnel state on the wire: `TunnelConfig` (user/host intent —
 * `subdomain`, `rootDomain`, `requestedRunning`) plus `TunnelState`
 * (daemon-owned — `running`, `currentSubdomain`, `currentRootDomain`,
 * `currentLocalPort`, `error`), plus `servedOrigin` (computed: the live
 * origin clients should reach the server at — `https://sub.root` when
 * the tunnel is up, else `http://localHostname:port` from LHS state).
 *
 * The forward-target port has a single source of truth in
 * `LocalHttpServerState.port`; it isn't carried on the tunnel wire
 * format. `currentLocalPort` reflects what port the tunnel daemon last
 * successfully bound to.
 *
 * Optional fields surface as `null` on the wire — both when the
 * persistent `TunnelConfig` row hasn't been seeded yet and when the
 * daemon hasn't populated the corresponding `current*` field.
 * `requestedRunning` / `running` always surface (default `false`).
 */
const TunnelStateSchema = Schema.Struct({
  subdomain: Schema.NullOr(Schema.String),
  rootDomain: Schema.NullOr(Schema.String),
  requestedRunning: Schema.Boolean,
  running: Schema.Boolean,
  currentSubdomain: Schema.NullOr(Schema.String),
  currentRootDomain: Schema.NullOr(Schema.String),
  currentLocalPort: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  servedOrigin: Schema.String,
})

/**
 * PATCH body — config-side fields only. The daemon owns the `running`,
 * `current*`, and `error` fields; no API path writes them. `null`
 * explicitly clears a field; `undefined` (key absent) preserves it.
 */
const SetTunnelRequestBodySchema = Schema.Struct({
  subdomain: Schema.optional(Schema.NullOr(Schema.String)),
  rootDomain: Schema.optional(Schema.NullOr(Schema.String)),
  requestedRunning: Schema.optional(Schema.Boolean),
})

/**
 * Tunnel-state endpoints. The group carries no middleware — the
 * composing app (e.g. `wildflower-server`) applies `RequireAuthMiddleware`
 * when adding `TunnelAdminApi` to its root `HttpApi`. Slice cores stay
 * free of auth dependencies.
 */
const httpApiGroup = HttpApiGroup.make('tunnel', { topLevel: false })
  .add(HttpApiEndpoint.get('GetTunnel', '/tunnel').addSuccess(TunnelStateSchema))
  .add(
    HttpApiEndpoint.patch('PatchTunnel', '/tunnel')
      .setPayload(SetTunnelRequestBodySchema)
      .addSuccess(TunnelStateSchema)
  )

export { httpApiGroup, SetTunnelRequestBodySchema, TunnelStateSchema }
