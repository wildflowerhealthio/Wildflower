import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect, Option } from 'effect'
import { isLoopbackPeer } from 'navigation-core'

/**
 * Network trust gate: reject any caller whose connection-level remote
 * address isn't loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x`) with a
 * `403`. The server is meant to be reached only over loopback — directly
 * by a local user/webview, or via the local tunnel client (which proxies
 * through `127.0.0.1`); LAN or raw-IP access is denied even when the
 * listener is bound to a non-loopback interface.
 *
 * Pairs with the platform entrypoints' loopback-only bind
 * (`isLoopbackBindHost`) and the per-handler
 * `requestOriginFromHttpRequest` checks, so a forged `Host` from a
 * non-loopback peer can never steer the origin a handler echoes. Sits
 * inside `accessLogMiddleware` so rejected peers are still logged.
 */
const loopbackGateMiddleware = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const remoteAddress = Option.getOrUndefined(request.remoteAddress)
    if (isLoopbackPeer(remoteAddress)) {
      return yield* app
    }
    yield* Effect.logWarning(
      `[http] rejected non-loopback peer (remoteAddress=${String(remoteAddress)})`
    )
    return HttpServerResponse.text('Forbidden', {
      status: 403,
      contentType: 'text/plain; charset=utf-8',
    })
  })
)

export { loopbackGateMiddleware }
