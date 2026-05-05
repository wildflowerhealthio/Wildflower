import { Effect, Either, Layer } from 'effect'
import { Origin } from 'kitchen-sink'
import { expect, test } from 'vite-plus/test'
import { type GatekeeperStore, makeGatekeeperStoreLayer } from '../src/contexts/gatekeeper-store.ts'
import { verifyJwt } from '../src/internal/jwt.ts'
import { Grants, Sessions, SigningKeys } from '../src/livestore/index.ts'

type FakeJwk = {
  signJwt: (payload: Record<string, unknown>) => Promise<string>
  verifyJwt: (token: string) => Promise<{ payload: Record<string, unknown> }>
  publicJwk: () => Record<string, unknown>
}

type GrantRow = {
  id: string
  clientId: string
  scopes: ReadonlyArray<string>
  redirectUri: string
  patient: string | null
}

type SessionRow = { id: string }

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

const makeStubStore = (options: {
  jwks: ReadonlyArray<FakeJwk>
  grants?: ReadonlyArray<GrantRow>
  sessions?: ReadonlyArray<SessionRow>
}): typeof GatekeeperStore.Service => {
  const { jwks, grants = [], sessions = [] } = options
  const grantRows = [...grants]
  const sessionMap = new Map(sessions.map((s) => [s.id, s]))

  const query = (q: unknown): unknown => {
    if (q === SigningKeys.queries.all$) return jwks
    const label = labelOf(q)
    const hash = hashOf(q)
    if (label === 'grantsByClientId' && hash !== undefined) {
      const seen = new Set(grantRows.map((g) => g.clientId))
      for (const clientId of seen) {
        if (Grants.queries.byClientId$(clientId).hash === hash) {
          return grantRows.filter((g) => g.clientId === clientId)
        }
      }
      return []
    }
    if (label === 'sessionById' && hash !== undefined) {
      for (const id of sessionMap.keys()) {
        if (Sessions.queries.byId$(id).hash === hash) {
          return sessionMap.get(id) ?? null
        }
      }
      return null
    }
    return []
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { query, commit: () => undefined } as unknown as typeof GatekeeperStore.Service
}

const ORIGIN = 'https://example.test'

const fakeJwk = (payload: Record<string, unknown>): FakeJwk => ({
  signJwt: async () => 'unused',
  verifyJwt: async () => ({ payload }),
  publicJwk: () => ({}),
})

const runVerify = (
  store: typeof GatekeeperStore.Service,
  token: string
): Promise<Either.Either<void, unknown>> =>
  Effect.runPromise(
    verifyJwt(token).pipe(
      Effect.provide(makeGatekeeperStoreLayer(store)),
      Effect.provide(Layer.succeed(Origin, ORIGIN)),
      Effect.either
    )
  )

test('access_token JWT verifies when a matching grant exists', async () => {
  const store = makeStubStore({
    jwks: [
      fakeJwk({
        iss: ORIGIN,
        aud: `${ORIGIN}/fhir`,
        sub: 'client-1',
        type: 'access_token',
      }),
    ],
    grants: [
      {
        id: 'g-1',
        clientId: 'client-1',
        scopes: [],
        redirectUri: 'https://app.example/cb',
        patient: null,
      },
    ],
  })
  const result = await runVerify(store, 'token')
  expect(Either.isRight(result)).toBe(true)
})

test('access_token JWT is rejected when no grant matches', async () => {
  const store = makeStubStore({
    jwks: [
      fakeJwk({
        iss: ORIGIN,
        aud: `${ORIGIN}/fhir`,
        sub: 'unknown-client',
        type: 'access_token',
      }),
    ],
  })
  const result = await runVerify(store, 'token')
  expect(Either.isLeft(result)).toBe(true)
})

test('session JWT verifies when a matching session exists', async () => {
  const store = makeStubStore({
    jwks: [
      fakeJwk({
        iss: ORIGIN,
        aud: ORIGIN,
        sub: 'session-1',
        type: 'session',
      }),
    ],
    sessions: [{ id: 'session-1' }],
  })
  const result = await runVerify(store, 'token')
  expect(Either.isRight(result)).toBe(true)
})

test('session JWT is rejected when no matching session exists', async () => {
  const store = makeStubStore({
    jwks: [
      fakeJwk({
        iss: ORIGIN,
        aud: ORIGIN,
        sub: 'session-missing',
        type: 'session',
      }),
    ],
  })
  const result = await runVerify(store, 'token')
  expect(Either.isLeft(result)).toBe(true)
})

test('JWT without recognised type claim is rejected', async () => {
  const store = makeStubStore({
    jwks: [
      fakeJwk({
        iss: ORIGIN,
        aud: `${ORIGIN}/fhir`,
        sub: 'client-1',
        // no `type` claim
      }),
    ],
    grants: [
      {
        id: 'g-1',
        clientId: 'client-1',
        scopes: [],
        redirectUri: 'https://app.example/cb',
        patient: null,
      },
    ],
  })
  const result = await runVerify(store, 'token')
  expect(Either.isLeft(result)).toBe(true)
})

test('access_token JWT presented at session-required path is rejected when sub is not a grant', async () => {
  // Session-shape token (sub is a session id) but type=access_token: should
  // miss the grant lookup and fail.
  const store = makeStubStore({
    jwks: [
      fakeJwk({
        iss: ORIGIN,
        aud: ORIGIN,
        sub: 'session-1',
        type: 'access_token',
      }),
    ],
    sessions: [{ id: 'session-1' }],
  })
  const result = await runVerify(store, 'token')
  expect(Either.isLeft(result)).toBe(true)
})

test('session JWT with sub that points to a grant only is rejected', async () => {
  const store = makeStubStore({
    jwks: [
      fakeJwk({
        iss: ORIGIN,
        aud: ORIGIN,
        sub: 'client-1',
        type: 'session',
      }),
    ],
    grants: [
      {
        id: 'g-1',
        clientId: 'client-1',
        scopes: [],
        redirectUri: 'https://app.example/cb',
        patient: null,
      },
    ],
  })
  const result = await runVerify(store, 'token')
  expect(Either.isLeft(result)).toBe(true)
})
