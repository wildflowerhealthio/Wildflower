import { HttpMiddleware, HttpServerRequest } from '@effect/platform'
import { Effect } from 'effect'

// `HttpApiBuilder.toWebHandler` wraps fetch `Request`s via
// `HttpServerRequest.fromWeb`, which leaves `remoteAddress = None` since a
// fetch `Request` has no TCP socket. Production paths (`NodeHttpServer.layer`,
// `ExpoHttpServer.layer`) populate it from the socket, so the request-origin
// trust gate (`requestOriginFromHttpRequest`) trusts loopback callers. This
// middleware reads a custom `x-test-remote-address` header (defaulting to
// `127.0.0.1`) and overrides the wrapper's `None` so handler tests exercise
// the trusted-peer path. Mirrors `../../integration-tests/server-helpers.ts`.
const loopbackPeerMiddleware = HttpMiddleware.make((httpApp) =>
  Effect.updateService(httpApp, HttpServerRequest.HttpServerRequest, (request) =>
    request.modify({
      remoteAddress: request.headers['x-test-remote-address'] ?? '127.0.0.1',
    })
  )
)

export { loopbackPeerMiddleware }
