import { HttpMiddleware, HttpServerRequest } from '@effect/platform'
import { DateTime, Duration, Effect } from 'effect'

/**
 * Access log: one line per request, `method path -> status (Nms)`.
 * Sits at the outermost layer of the composed middleware so every served
 * route is covered — HttpApi handlers, the SPA fallback, Swagger.
 *
 * @remarks
 * The query string is stripped before logging — bootstrap URLs carry
 * `?token=…` and we don't want bearer material landing in logs. If a
 * request is needed for which the query string matters, capture it at
 * the handler level instead.
 *
 * `req.url` from `@effect/platform` is path-and-query, never absolute,
 * so the simple `indexOf('?')` split is safe — no scheme/host to
 * accidentally swallow.
 */
const accessLogMiddleware = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const start = yield* DateTime.now
    const req = yield* HttpServerRequest.HttpServerRequest
    const pathOnly = (() => {
      const idx = req.url.indexOf('?')
      return idx === -1 ? req.url : req.url.slice(0, idx)
    })()
    const response = yield* app
    const elapsed = DateTime.distanceDuration(start, yield* DateTime.now)
    yield* Effect.logDebug(
      `[http] ${req.method} ${pathOnly} -> ${response.status} (${Duration.toMillis(elapsed)}ms)`
    )
    return response
  })
)

export { accessLogMiddleware }
