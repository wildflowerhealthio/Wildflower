import { HttpApiError } from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'
import { Origin } from 'kitchen-sink'
import { GatekeeperStore } from '../contexts/gatekeeper-store.ts'
import { RequireAuthMiddleware } from '../http-api-definition/require-auth.ts'
import { verifyJwt } from '../internal/jwt.ts'

const OWNER_SCOPE = 'owner'

const authenticateOwner = (
  token: string
): Effect.Effect<void, HttpApiError.Unauthorized, GatekeeperStore | Origin> =>
  Effect.gen(function* () {
    const payload = yield* verifyJwt(token.trim())
    const scope = payload.scope ?? ''
    const scopes = scope.split(' ').filter(Boolean)
    if (!scopes.includes(OWNER_SCOPE)) {
      return yield* Effect.fail(new HttpApiError.Unauthorized())
    }
    return undefined
  })

const RequireAuthMiddlewareLive = Layer.effect(
  RequireAuthMiddleware,
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const origin = yield* Origin
    return {
      bearer: (token: Redacted.Redacted<string>) =>
        authenticateOwner(Redacted.value(token)).pipe(
          Effect.provideService(GatekeeperStore, store),
          Effect.provideService(Origin, origin)
        ),
    }
  })
)

export { RequireAuthMiddleware, RequireAuthMiddlewareLive }
