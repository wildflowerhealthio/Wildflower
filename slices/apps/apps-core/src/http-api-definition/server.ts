import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import { RequireAuthMiddleware } from 'gatekeeper-core/http-api-implementation'

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
 * Server-config endpoints (tunnel state, origin info). Owner-only.
 * `RequireAuthMiddleware` is applied at the group level so the slice's
 * `-core` layer cannot ship these unauthenticated by accident.
 *
 * The companion `apps` group (listing / mutating / launching apps) is
 * deliberately unauthenticated — `LaunchApp` returns HTML to embedded
 * webviews and iframes that cannot easily carry a bearer token.
 */
const httpApiGroup = HttpApiGroup.make('server', { topLevel: false })
  .add(HttpApiEndpoint.get('GetServer', '/server').addSuccess(ServerStateSchema))
  .add(
    HttpApiEndpoint.patch('PatchServer', '/server')
      .setPayload(SetTunnelBodySchema)
      .addSuccess(ServerStateSchema)
      .addError(TunnelUnavailableSchema, { status: 409 })
  )
  .middleware(RequireAuthMiddleware)

export { httpApiGroup, ServerStateSchema, SetTunnelBodySchema, TunnelUnavailableSchema }
