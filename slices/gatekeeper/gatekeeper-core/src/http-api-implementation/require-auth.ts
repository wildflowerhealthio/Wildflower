import {
  HttpApiBuilder,
  HttpApiError,
  HttpApiMiddleware,
  HttpApiSecurity,
  HttpServerRequest,
  HttpServerResponse,
} from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'
import { Origin } from 'kitchen-sink'
import { AuthStore } from '../contexts/AuthStore.ts'
import { verifyJwt } from '../internal/jwt.ts'

const BearerTokenSecurity = HttpApiSecurity.bearer
const SessionCookieSecurity = HttpApiSecurity.apiKey({
  key: '__wildflower_session',
  in: 'cookie',
})

const authenticateToken = (
  token: string
): Effect.Effect<void, HttpApiError.Unauthorized, AuthStore> => verifyJwt(token.trim())

const authenticateStore: Effect.Effect<
  void,
  HttpApiError.Unauthorized,
  AuthStore | HttpServerRequest.HttpServerRequest | HttpServerRequest.ParsedSearchParams
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
        HttpServerResponse.redirect(`${origin}/auth/pin?returnTo=${returnTo}`, { status: 302 })
      )
    }
    return yield* Effect.fail(new HttpApiError.Unauthorized())
  })
)

class RequireAuthMiddleware extends HttpApiMiddleware.Tag<RequireAuthMiddleware>()(
  'RequireAuthMiddleware',
  {
    failure: HttpApiError.Unauthorized,
    security: {
      bearer: BearerTokenSecurity,
      session: SessionCookieSecurity,
    },
  }
) {}

const RequireAuthMiddlewareLive = Layer.effect(
  RequireAuthMiddleware,

  Effect.map(AuthStore, (store) => ({
    bearer: (token: Redacted.Redacted<string>) =>
      authenticateToken(Redacted.value(token)).pipe(Effect.provideService(AuthStore, store)),
    session: (token: Redacted.Redacted<string>) =>
      authenticateToken(Redacted.value(token)).pipe(Effect.provideService(AuthStore, store)),
  }))
)

export { RequireAuthMiddleware, RequireAuthMiddlewareLive, requireAuthOrRedirect }
