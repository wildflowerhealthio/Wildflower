import { DateTime, Effect } from 'effect'
import { AuthorizationCode, AuthorizationRequest, GatekeeperStore } from '../livestore/index.ts'
const cleanupExpiredAuthorizationRequests: Effect.Effect<void, never, GatekeeperStore> = Effect.gen(
  function* () {
    const store = yield* GatekeeperStore
    const expiredBefore = yield* DateTime.now
    store.commit(
      AuthorizationRequest.events.deleteAuthorizationRequestsExpiredAsOf({ expiredBefore })
    )
  }
)

const cleanupExpiredAuthorizationCodes: Effect.Effect<void, never, GatekeeperStore> = Effect.gen(
  function* () {
    const store = yield* GatekeeperStore
    const expiredBefore = yield* DateTime.now
    store.commit(AuthorizationCode.events.deleteAuthorizationCodesExpiredAsOf({ expiredBefore }))
  }
)

export { cleanupExpiredAuthorizationRequests, cleanupExpiredAuthorizationCodes }
