import { DateTime, Effect, Layer } from 'effect'
import { expect, test } from 'vite-plus/test'
import { GatekeeperStore } from '../src/contexts/gatekeeper-store.ts'
import {
  denyPinChallenge,
  MAX_PIN_ATTEMPTS,
  verifyPinChallenge,
} from '../src/contexts/pin-consent-decisions.ts'
import { hashPin } from '../src/internal/pin-hash.ts'
import { PinChallenges, type PinChallengeRow } from '../src/livestore/index.ts'

type Committed = { name: string; args: Record<string, unknown> }

const labelOf = (q: unknown): string | undefined => {
  if (typeof q === 'object' && q !== null && 'label' in q && typeof q.label === 'string') {
    return q.label
  }
  return undefined
}
const hashOf = (q: unknown): string | undefined => {
  if (typeof q === 'object' && q !== null && 'hash' in q && typeof q.hash === 'string') {
    return q.hash
  }
  return undefined
}

const makeFakeStore = (seed: {
  challenge?: PinChallengeRow
}): { store: typeof GatekeeperStore.Service; committed: Committed[] } => {
  const committed: Committed[] = []
  const challengeRow = seed.challenge

  const query = (q: unknown): unknown => {
    const label = labelOf(q)
    const hash = hashOf(q)
    if (label === 'pinChallengeById' && hash !== undefined && challengeRow != null) {
      if (PinChallenges.queries.byId$(challengeRow.id).hash === hash) {
        return challengeRow
      }
    }
    return null
  }

  const commit = (...events: ReadonlyArray<Committed>): void => {
    committed.push(...events)
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const store = { query, commit } as unknown as typeof GatekeeperStore.Service
  return { store, committed }
}

const makeChallenge = async (
  overrides: Partial<Omit<PinChallengeRow, 'pinHash'>> & { pin?: string } = {}
): Promise<PinChallengeRow> => {
  const id = overrides.id ?? 'pin-1'
  const plaintextPin = overrides.pin ?? '123456'
  const pinHash = await Effect.runPromise(hashPin(id, plaintextPin))
  const { pin: _pin, ...rest } = overrides
  return {
    id,
    pinHash,
    returnTo: '/',
    expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '2 minutes'),
    status: 'pending',
    attempts: 0,
    ...rest,
  }
}

const runWithStore = <A>(
  effect: Effect.Effect<A, never, GatekeeperStore>,
  store: typeof GatekeeperStore.Service
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.succeed(GatekeeperStore, store))))

test('verifyPinChallenge commits verified + sessionStarted on correct PIN', async () => {
  const challenge = await makeChallenge({ pin: '123456' })
  const { store, committed } = makeFakeStore({ challenge })
  const ok = await runWithStore(verifyPinChallenge('pin-1', '123456', '15min'), store)
  expect(ok).toBe(true)
  expect(committed.map((e) => e.name)).toEqual(['v1.PinChallengeVerified', 'v1.SessionStarted'])
})

test('verifyPinChallenge increments attempts on wrong PIN below the max threshold', async () => {
  const challenge = await makeChallenge({ pin: '123456', attempts: 0 })
  const { store, committed } = makeFakeStore({ challenge })
  const ok = await runWithStore(verifyPinChallenge('pin-1', '999999', 'request'), store)
  expect(ok).toBe(false)
  expect(committed.map((e) => e.name)).toEqual(['v1.PinChallengeAttemptFailed'])
})

test('verifyPinChallenge rejects the challenge after MAX_PIN_ATTEMPTS', async () => {
  const challenge = await makeChallenge({
    pin: '123456',
    attempts: MAX_PIN_ATTEMPTS - 1,
  })
  const { store, committed } = makeFakeStore({ challenge })
  const ok = await runWithStore(verifyPinChallenge('pin-1', '999999', 'request'), store)
  expect(ok).toBe(false)
  expect(committed.map((e) => e.name)).toEqual(['v1.PinChallengeRejected'])
})

test('denyPinChallenge commits rejection when the challenge exists', async () => {
  const challenge = await makeChallenge()
  const { store, committed } = makeFakeStore({ challenge })
  await runWithStore(denyPinChallenge('pin-1'), store)
  expect(committed.map((e) => e.name)).toEqual(['v1.PinChallengeRejected'])
})

test('denyPinChallenge is a no-op when the challenge is missing', async () => {
  const { store, committed } = makeFakeStore({})
  await runWithStore(denyPinChallenge('missing'), store)
  expect(committed).toEqual([])
})
