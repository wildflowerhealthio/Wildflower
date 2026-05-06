import { DateTime, Effect } from 'effect'
import { AuthorizationCodes, AuthorizationRequests } from '../livestore/index.ts'
import { GatekeeperStore } from './gatekeeper-store.ts'

const cleanupExpiredAuthorizationRequests: Effect.Effect<void, never, GatekeeperStore> = Effect.gen(
  function* () {
    const store = yield* GatekeeperStore
    const expiredBefore = yield* DateTime.now
    store.commit(
      AuthorizationRequests.events.deleteAuthorizationRequestsExpiredAsOf({ expiredBefore })
    )
  }
)

const cleanupExpiredAuthorizationCodes: Effect.Effect<void, never, GatekeeperStore> = Effect.gen(
  function* () {
    const store = yield* GatekeeperStore
    const expiredBefore = yield* DateTime.now
    store.commit(AuthorizationCodes.events.deleteAuthorizationCodesExpiredAsOf({ expiredBefore }))
  }
)

export { cleanupExpiredAuthorizationRequests, cleanupExpiredAuthorizationCodes }
