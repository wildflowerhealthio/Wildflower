import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

/**
 * Public-facing tunnel API shape — surfaces the raw store fields rather
 * than a derived "active" flag. Consumers compose anything derived
 * (e.g. `active = currentPublicOrigin !== undefined`) themselves.
 *
 * `running`, `localOrigin`, and `port` are mirrored from the
 * `LocalHttpServerStore` so clients can render server status without a
 * second round-trip.
 */
const TunnelStateSchema = Schema.Struct({
  requestedPublicOrigin: Schema.optional(Schema.String),
  currentPublicOrigin: Schema.optional(Schema.String),
  localOrigin: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  running: Schema.Boolean,
})

/**
 * PATCH body — `requestedPublicOrigin: null` clears the request (asks
 * the daemon to tear the tunnel down); a string commits a new request.
 */
const SetTunnelRequestBodySchema = Schema.Struct({
  requestedPublicOrigin: Schema.NullOr(Schema.String),
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
