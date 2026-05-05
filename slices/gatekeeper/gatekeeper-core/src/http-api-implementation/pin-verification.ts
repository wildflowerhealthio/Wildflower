import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'
import { GatekeeperStore } from '../contexts/gatekeeper-store.ts'
import { denyPinChallenge, verifyPinChallenge } from '../contexts/pin-consent-decisions.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import { PinChallenges } from '../livestore/index.ts'

const layer = HttpApiBuilder.group(GatekeeperApi, 'pin-verification', (handlers) =>
  handlers
    .handle('GetPinVerification', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore

        const challenge = store.query(PinChallenges.queries.byId$(id))
        if (challenge == null) {
          return yield* Effect.fail({
            error: 'PinVerificationNotFound' as const,
            id,
          })
        }

        return {
          id,
          returnTo: challenge.returnTo,
          expiresAt: challenge.expiresAt,
        }
      })
    )
    .handle('VerifyPin', ({ path: { id }, payload }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const pending = store.query(PinChallenges.queries.byId$(id))
        if (pending == null) {
          return yield* Effect.fail({
            error: 'PinVerificationNotFound' as const,
            id,
          })
        }
        const ok = yield* verifyPinChallenge(id, payload.pin, payload.duration)
        if (!ok) return { status: 'invalid_pin' as const }
        return { status: 'approved' as const }
      })
    )
    .handle('DenyPinVerification', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const pending = store.query(PinChallenges.queries.byId$(id))
        if (pending == null) {
          return yield* Effect.fail({
            error: 'PinVerificationNotFound' as const,
            id,
          })
        }
        yield* denyPinChallenge(id)
        return { status: 'denied' as const }
      })
    )
)

export { layer }
