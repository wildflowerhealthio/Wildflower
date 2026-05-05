import {
  HttpApiBuilder,
  HttpApiError,
  HttpServerRequest,
  HttpServerResponse,
} from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'
import { Origin } from 'kitchen-sink'
import { GatekeeperStore } from '../contexts/gatekeeper-store.ts'
import {
  BearerTokenSecurity,
  RequireAuthMiddleware,
  SessionCookieSecurity,
} from '../http-api-definition/require-auth.ts'
import { verifyJwt } from '../internal/jwt.ts'

const authenticateToken = (
  token: string
): Effect.Effect<void, HttpApiError.Unauthorized, GatekeeperStore | Origin> =>
  verifyJwt(token.trim())

const authenticateStore: Effect.Effect<
  void,
  HttpApiError.Unauthorized,
  | GatekeeperStore
  | Origin
  | HttpServerRequest.HttpServerRequest
  | HttpServerRequest.ParsedSearchParams
> = Effect.gen(function* () {
  const bearer = yield* Effect.either(
    Effect.flatMap(HttpApiBuilder.securityDecode(BearerTokenSecurity), (token) =>
      authenticateToken(Redacted.value(token))
    )
  )

  if (bearer._tag === 'Right') {
    return
  }

  yield* Effect.flatMap(HttpApiBuilder.securityDecode(SessionCookieSecurity), (token) =>
    authenticateToken(Redacted.value(token))
  )
})

const requireAuthOrRedirect = Effect.catchAll(authenticateStore, () =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const accept = req.headers['accept'] ?? ''
    if (accept.includes('text/html')) {
      const origin = yield* Origin
      const returnTo = encodeURIComponent(req.url)
      return yield* Effect.fail(
        HttpServerResponse.redirect(`${origin}/login/pin?returnTo=${returnTo}`, { status: 302 })
      )
    }
    return yield* Effect.fail(new HttpApiError.Unauthorized())
  })
)

const RequireAuthMiddlewareLive = Layer.effect(
  RequireAuthMiddleware,
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const origin = yield* Origin
    return {
      bearer: (token: Redacted.Redacted<string>) =>
        authenticateToken(Redacted.value(token)).pipe(
          Effect.provideService(GatekeeperStore, store),
          Effect.provideService(Origin, origin)
        ),
      session: (token: Redacted.Redacted<string>) =>
        authenticateToken(Redacted.value(token)).pipe(
          Effect.provideService(GatekeeperStore, store),
          Effect.provideService(Origin, origin)
        ),
    }
  })
)

export { RequireAuthMiddleware, RequireAuthMiddlewareLive, requireAuthOrRedirect }
