import { DateTime, Effect } from 'effect'
import { AuthorizationCodes, AuthorizationRequests, PinChallenges } from '../livestore/index.ts'
import { GatekeeperStore } from './gatekeeper-store.ts'

const cleanupExpiredPinChallenges: Effect.Effect<void, never, GatekeeperStore> = Effect.gen(
  function* () {
    const store = yield* GatekeeperStore
    const now = yield* DateTime.now
    const expired = store.query(PinChallenges.queries.allExpired$(now))
    for (const row of expired) {
      if (row.status === 'pending') {
        store.commit(PinChallenges.events.pinChallengeExpired({ id: row.id }))
      }
    }
  }
)

const cleanupExpiredAuthorizationRequests: Effect.Effect<void, never, GatekeeperStore> = Effect.gen(
  function* () {
    const store = yield* GatekeeperStore
    const now = yield* DateTime.now
    const expired = store.query(AuthorizationRequests.queries.allExpired$(now))
    for (const row of expired) {
      if (row.status === 'pending') {
        store.commit(AuthorizationRequests.events.authorizationRequestExpired({ id: row.id }))
      }
    }
  }
)

const cleanupExpiredAuthorizationCodes: Effect.Effect<void, never, GatekeeperStore> = Effect.gen(
  function* () {
    const store = yield* GatekeeperStore
    const now = yield* DateTime.now
    const expired = store.query(AuthorizationCodes.queries.allExpired$(now))
    for (const row of expired) {
      store.commit(AuthorizationCodes.events.authorizationCodeConsumed({ code: row.code }))
    }
  }
)

export {
  cleanupExpiredPinChallenges,
  cleanupExpiredAuthorizationRequests,
  cleanupExpiredAuthorizationCodes,
}
