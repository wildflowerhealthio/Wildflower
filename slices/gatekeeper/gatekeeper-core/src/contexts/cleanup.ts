import { DateTime, Effect } from 'effect'
import { AuthorizationCodes, AuthorizationRequests } from '../livestore/index.ts'
import { GatekeeperStore } from './gatekeeper-store.ts'

const cleanupExpiredAuthorizationRequests: Effect.Effect<void, never, GatekeeperStore> = Effect.gen(
  function* () {
    const store = yield* GatekeeperStore
    const now = yield* DateTime.now
    const expired = store.query(AuthorizationRequests.queries.allExpired$(now))
    const ids = expired.filter((row) => row.status === 'pending').map((row) => row.id)
    if (ids.length === 0) return
    store.commit(AuthorizationRequests.events.authorizationRequestsExpiredAsOf({ ids }))
  }
)

const cleanupExpiredAuthorizationCodes: Effect.Effect<void, never, GatekeeperStore> = Effect.gen(
  function* () {
    const store = yield* GatekeeperStore
    const now = yield* DateTime.now
    const expired = store.query(AuthorizationCodes.queries.allExpired$(now))
    const codes = expired.map((row) => row.code)
    if (codes.length === 0) return
    store.commit(AuthorizationCodes.events.authorizationCodesExpiredAsOf({ codes }))
  }
)

export { cleanupExpiredAuthorizationRequests, cleanupExpiredAuthorizationCodes }
