import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

/**
 * Merged tunnel state on the wire: `TunnelConfig` (user/host intent —
 * `subdomain`, `rootDomain`, `localPort`, `requestedEnabled`) plus
 * `TunnelState` (daemon-owned — `currentEnabled`, `currentSubdomain`,
 * `currentRootDomain`, `currentLocalPort`, `error`).
 *
 * Optional fields surface as `null` on the wire — both when the
 * persistent `TunnelConfig` row hasn't been seeded yet and when the
 * daemon hasn't populated the corresponding `current*` field.
 * `requestedEnabled` / `currentEnabled` always surface (default `false`).
 */
const TunnelStateSchema = Schema.Struct({
  subdomain: Schema.NullOr(Schema.String),
  rootDomain: Schema.NullOr(Schema.String),
  localPort: Schema.NullOr(Schema.Number),
  requestedEnabled: Schema.Boolean,
  currentEnabled: Schema.Boolean,
  currentSubdomain: Schema.NullOr(Schema.String),
  currentRootDomain: Schema.NullOr(Schema.String),
  currentLocalPort: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
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
