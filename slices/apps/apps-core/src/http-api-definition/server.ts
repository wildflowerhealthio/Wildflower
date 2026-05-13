import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

const ServerStateSchema = Schema.Struct({
  origin: Schema.String,
  localOrigin: Schema.String,
  port: Schema.Number,
  tunnelActive: Schema.Boolean,
})

const SetTunnelBodySchema = Schema.Struct({
  tunnelActive: Schema.Boolean,
})

const TunnelUnavailableSchema = Schema.Struct({
  error: Schema.Literal('TunnelUnavailable'),
  reason: Schema.String,
})

/**
 * Server-config endpoints (tunnel state, origin info). The group
 * carries no middleware — `wildflower-server` (or any other composing
 * app) applies `RequireAuthMiddleware` when adding `AppsAdminApi` to
 * its root `HttpApi`. Slice cores stay free of auth dependencies.
 */
const httpApiGroup = HttpApiGroup.make('server', { topLevel: false })
  .add(HttpApiEndpoint.get('GetServer', '/server').addSuccess(ServerStateSchema))
  .add(
    HttpApiEndpoint.patch('PatchServer', '/server')
      .setPayload(SetTunnelBodySchema)
      .addSuccess(ServerStateSchema)
      .addError(TunnelUnavailableSchema, { status: 409 })
  )

export { httpApiGroup, ServerStateSchema, SetTunnelBodySchema, TunnelUnavailableSchema }
