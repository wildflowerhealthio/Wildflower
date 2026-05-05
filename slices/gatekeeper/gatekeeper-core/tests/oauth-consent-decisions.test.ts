import { DateTime, Effect, Layer } from 'effect'
import { expect, test } from 'vite-plus/test'
import { GatekeeperStore } from '../src/contexts/gatekeeper-store.ts'
import {
  approveAuthorizationRequest,
  denyAuthorizationRequest,
} from '../src/contexts/oauth-consent-decisions.ts'
import { AuthorizationRequests, type AuthorizationRequestRow } from '../src/livestore/index.ts'

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
}): { store: typeof GatekeeperStore.Service; committed: Committed[] } => {
  const committed: Committed[] = []
  const requestRow = seed.request

  const query = (q: unknown): unknown => {
    const label = labelOf(q)
    const hash = hashOf(q)
    if (label === 'authorizationRequestById' && hash !== undefined && requestRow != null) {
      if (AuthorizationRequests.queries.byId$(requestRow.id).hash === hash) {
        return requestRow
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

const runWithStore = <A>(
  effect: Effect.Effect<A, never, GatekeeperStore>,
  store: typeof GatekeeperStore.Service
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.succeed(GatekeeperStore, store))))

test('approveAuthorizationRequest commits approval + code-issued and returns redirect URL', async () => {
  const { store, committed } = makeFakeStore({ request: makeRequest() })
  const redirect = await runWithStore(
    approveAuthorizationRequest('req-1', ['patient/*.read'], 'patient-7'),
    store
  )
  expect(redirect).not.toBeNull()
  expect(redirect).toContain('https://app.example/cb?')
  expect(redirect).toContain('code=')
  expect(redirect).toContain('state=state-x')
  expect(committed.map((e) => e.name)).toEqual([
    'v1.AuthorizationRequestApproved',
    'v1.AuthorizationCodeIssued',
  ])
})

test('approveAuthorizationRequest returns null when the request is missing', async () => {
  const { store, committed } = makeFakeStore({})
  const redirect = await runWithStore(approveAuthorizationRequest('missing', ['scope-a']), store)
  expect(redirect).toBeNull()
  expect(committed).toEqual([])
})

test('denyAuthorizationRequest commits denial event when the request exists', async () => {
  const { store, committed } = makeFakeStore({ request: makeRequest() })
  await runWithStore(denyAuthorizationRequest('req-1'), store)
  expect(committed.map((e) => e.name)).toEqual(['v1.AuthorizationRequestDenied'])
})

test('denyAuthorizationRequest is a no-op when the request is missing', async () => {
  const { store, committed } = makeFakeStore({})
  await runWithStore(denyAuthorizationRequest('missing'), store)
  expect(committed).toEqual([])
})
