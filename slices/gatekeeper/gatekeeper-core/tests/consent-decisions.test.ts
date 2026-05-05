import { DateTime } from 'effect'
import { expect, test } from 'vite-plus/test'
import {
  approveAuthorizationRequest,
  denyAuthorizationRequest,
  denyPinChallenge,
  MAX_PIN_ATTEMPTS,
  verifyPinChallenge,
} from '../src/contexts/consent-decisions.ts'
import { type GatekeeperStore } from '../src/contexts/GatekeeperStore.ts'
import {
  AuthorizationRequests,
  type AuthorizationRequestRow,
  PinChallenges,
  type PinChallengeRow,
} from '../src/livestore/index.ts'

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
  request?: AuthorizationRequestRow
  challenge?: PinChallengeRow
}): { store: typeof GatekeeperStore.Service; committed: Committed[] } => {
  const committed: Committed[] = []
  const requestRow = seed.request
  const challengeRow = seed.challenge

  const query = (q: unknown): unknown => {
    const label = labelOf(q)
    const hash = hashOf(q)
    if (label === 'authorizationRequestById' && hash !== undefined && requestRow != null) {
      if (AuthorizationRequests.queries.byId$(requestRow.id).hash === hash) {
        return requestRow
      }
    }
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

const makeRequest = (
  overrides: Partial<AuthorizationRequestRow> = {}
): AuthorizationRequestRow => ({
  id: 'req-1',
  clientId: 'client-1',
  requestedScopes: ['patient/*.read'],
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256',
  redirectUri: 'https://app.example/cb',
  clientState: 'state-x',
  preApprovedScopes: null,
  requestedAt: DateTime.unsafeNow(),
  expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '5 minutes'),
  status: 'pending',
  grantedScopes: null,
  patient: null,
  ...overrides,
})

const makeChallenge = (overrides: Partial<PinChallengeRow> = {}): PinChallengeRow => ({
  id: 'pin-1',
  pin: '123456',
  returnTo: '/',
  expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '2 minutes'),
  status: 'pending',
  attempts: 0,
  ...overrides,
})

test('approveAuthorizationRequest commits approval + code-issued and returns redirect URL', () => {
  const { store, committed } = makeFakeStore({ request: makeRequest() })
  const redirect = approveAuthorizationRequest(store, 'req-1', ['patient/*.read'], 'patient-7')
  expect(redirect).not.toBeNull()
  expect(redirect).toContain('https://app.example/cb?')
  expect(redirect).toContain('code=')
  expect(redirect).toContain('state=state-x')
  expect(committed.map((e) => e.name)).toEqual([
    'v1.AuthorizationRequestApproved',
    'v1.AuthorizationCodeIssued',
  ])
})

test('approveAuthorizationRequest returns null when the request is missing', () => {
  const { store, committed } = makeFakeStore({})
  const redirect = approveAuthorizationRequest(store, 'missing', ['scope-a'])
  expect(redirect).toBeNull()
  expect(committed).toEqual([])
})

test('denyAuthorizationRequest commits denial event when the request exists', () => {
  const { store, committed } = makeFakeStore({ request: makeRequest() })
  denyAuthorizationRequest(store, 'req-1')
  expect(committed.map((e) => e.name)).toEqual(['v1.AuthorizationRequestDenied'])
})

test('denyAuthorizationRequest is a no-op when the request is missing', () => {
  const { store, committed } = makeFakeStore({})
  denyAuthorizationRequest(store, 'missing')
  expect(committed).toEqual([])
})

test('verifyPinChallenge commits verified + sessionStarted on correct PIN', () => {
  const { store, committed } = makeFakeStore({ challenge: makeChallenge() })
  const ok = verifyPinChallenge(store, 'pin-1', '123456', '15min')
  expect(ok).toBe(true)
  expect(committed.map((e) => e.name)).toEqual(['v1.PinChallengeVerified', 'v1.SessionStarted'])
})

test('verifyPinChallenge increments attempts on wrong PIN below the max threshold', () => {
  const { store, committed } = makeFakeStore({ challenge: makeChallenge({ attempts: 0 }) })
  const ok = verifyPinChallenge(store, 'pin-1', '999999', 'request')
  expect(ok).toBe(false)
  expect(committed.map((e) => e.name)).toEqual(['v1.PinChallengeAttemptFailed'])
})

test('verifyPinChallenge rejects the challenge after MAX_PIN_ATTEMPTS', () => {
  const { store, committed } = makeFakeStore({
    challenge: makeChallenge({ attempts: MAX_PIN_ATTEMPTS - 1 }),
  })
  const ok = verifyPinChallenge(store, 'pin-1', '999999', 'request')
  expect(ok).toBe(false)
  expect(committed.map((e) => e.name)).toEqual(['v1.PinChallengeRejected'])
})

test('denyPinChallenge commits rejection when the challenge exists', () => {
  const { store, committed } = makeFakeStore({ challenge: makeChallenge() })
  denyPinChallenge(store, 'pin-1')
  expect(committed.map((e) => e.name)).toEqual(['v1.PinChallengeRejected'])
})

test('denyPinChallenge is a no-op when the challenge is missing', () => {
  const { store, committed } = makeFakeStore({})
  denyPinChallenge(store, 'missing')
  expect(committed).toEqual([])
})
