import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

/**
 * Merged tunnel state on the wire: `TunnelConfig` (user/host intent —
 * `subdomain`, `rootDomain`, `localPort`, `requestedEnabled`) plus
 * `TunnelState` (daemon-owned — `currentEnabled`, `currentSubdomain`,
 * `currentRootDomain`, `currentLocalPort`, `error`).
 *
 * Optional fields decay to `undefined` on the wire when the persistent
 * `TunnelConfig` row hasn't been seeded yet — `requestedEnabled` always
 * surfaces (defaults to `false`).
 */
const TunnelStateSchema = Schema.Struct({
  subdomain: Schema.optional(Schema.String),
  rootDomain: Schema.optional(Schema.String),
  localPort: Schema.optional(Schema.Number),
  requestedEnabled: Schema.Boolean,
  currentEnabled: Schema.Boolean,
  currentSubdomain: Schema.optional(Schema.String),
  currentRootDomain: Schema.optional(Schema.String),
  currentLocalPort: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
})

/**
 * PATCH body — config-side fields only. The daemon owns the `current*`
 * and `error` fields; no API path writes them. `null` explicitly clears
 * a field; `undefined` (key absent) preserves it.
 */
const SetTunnelRequestBodySchema = Schema.Struct({
  subdomain: Schema.optional(Schema.NullOr(Schema.String)),
  rootDomain: Schema.optional(Schema.NullOr(Schema.String)),
  localPort: Schema.optional(Schema.NullOr(Schema.Number)),
  requestedEnabled: Schema.optional(Schema.Boolean),
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
