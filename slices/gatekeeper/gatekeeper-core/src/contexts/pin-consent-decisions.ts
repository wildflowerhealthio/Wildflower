import { DateTime, Effect } from 'effect'
import { hashPin } from '../internal/pin-hash.ts'
import { timingSafeEqual } from '../internal/timing-safe-equal.ts'
import { PinChallenges, Sessions, type SessionDuration } from '../livestore/index.ts'
import { GatekeeperStore } from './gatekeeper-store.ts'

const MAX_PIN_ATTEMPTS = 5

const sessionMaxAgeSeconds = (duration: SessionDuration): number => {
  if (duration === '15min') return 900
  if (duration === '1min') return 60
  return 30
}

/**
 * Validate a PIN attempt against the stored hash. On success the challenge is
 * marked verified and a corresponding `sessions` row is created with the
 * given duration. The session id reuses the challenge id so the `/complete`
 * handler can find it. On failure the attempts counter is incremented; once
 * {@link MAX_PIN_ATTEMPTS} is reached the row is rejected and `false` is
 * returned.
 */
const verifyPinChallenge = (
  id: string,
  enteredPin: string,
  duration: SessionDuration
): Effect.Effect<boolean, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const pending = store.query(PinChallenges.queries.byId$(id))
    if (pending == null) return false

    const enteredHash = yield* hashPin(id, enteredPin)
    if (!timingSafeEqual(pending.pinHash, enteredHash)) {
      const attempts = pending.attempts + 1
      if (attempts >= MAX_PIN_ATTEMPTS) {
        store.commit(PinChallenges.events.pinChallengeRejected({ id }))
        return false
      }
      store.commit(PinChallenges.events.pinChallengeAttemptFailed({ id, attempts }))
      return false
    }

    const startedAt = yield* DateTime.now
    const expiresAt = DateTime.addDuration(startedAt, `${sessionMaxAgeSeconds(duration)} seconds`)
    store.commit(
      PinChallenges.events.pinChallengeVerified({ id }),
      Sessions.events.sessionStarted({
        id,
        startedAt,
        expiresAt,
        duration,
        label: 'PIN session',
      })
    )
    return true
  })

const denyPinChallenge = (id: string): Effect.Effect<void, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const pending = store.query(PinChallenges.queries.byId$(id))
    if (pending == null) return
    store.commit(PinChallenges.events.pinChallengeRejected({ id }))
  })

export { verifyPinChallenge, denyPinChallenge, MAX_PIN_ATTEMPTS }
