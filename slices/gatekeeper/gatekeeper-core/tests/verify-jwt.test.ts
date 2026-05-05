import { DateTime, Effect, Either, Layer } from 'effect'
import { Origin } from 'kitchen-sink'
import { expect, test } from 'vite-plus/test'
import { type GatekeeperStore, makeGatekeeperStoreLayer } from '../src/contexts/gatekeeper-store.ts'
import { verifyJwt } from '../src/internal/jwt.ts'
import { Clients, type ClientRow, SigningKeys } from '../src/livestore/index.ts'

type FakeJwk = {
  signJwt: (payload: Record<string, unknown>) => Promise<string>
  verifyJwt: (token: string) => Promise<{ payload: Record<string, unknown> }>
  publicJwk: () => Record<string, unknown>
}

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
  clients?: ReadonlyArray<ClientRow>
}): typeof GatekeeperStore.Service => {
  const { jwks, clients = [] } = options
  const clientMap = new Map(clients.map((c) => [c.clientId, c]))

  const query = (q: unknown): unknown => {
    if (q === SigningKeys.queries.all$) return jwks
    const label = labelOf(q)
    const hash = hashOf(q)
    if (label === 'clientById' && hash !== undefined) {
      for (const clientId of clientMap.keys()) {
        if (Clients.queries.byId$(clientId).hash === hash) {
          return clientMap.get(clientId) ?? null
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

const makeClient = (overrides: Partial<ClientRow> = {}): ClientRow => ({
  clientId: 'client-1',
  name: 'Test Client',
  kind: 'public',
  redirectUris: [],
  allowedScopes: ['owner'],
  secretHash: null,
  registeredAt: DateTime.unsafeNow(),
  disabledAt: null,
  ...overrides,
})

const runVerify = (
  store: typeof GatekeeperStore.Service,
  token: string
): Promise<Either.Either<unknown, unknown>> =>
  Effect.runPromise(
    verifyJwt(token).pipe(
      Effect.provide(makeGatekeeperStoreLayer(store)),
      Effect.provide(Layer.succeed(Origin, ORIGIN)),
      Effect.either
    )
  )

test('JWT verifies when sub matches a registered client (no type claim)', async () => {
  const store = makeStubStore({
    jwks: [
      fakeJwk({
        iss: ORIGIN,
        aud: `${ORIGIN}/fhir`,
        sub: 'client-1',
      }),
    ],
    clients: [makeClient()],
  })
  const result = await runVerify(store, 'token')
  expect(Either.isRight(result)).toBe(true)
})

test('JWT is rejected when sub does not match any client', async () => {
  const store = makeStubStore({
    jwks: [
      fakeJwk({
        iss: ORIGIN,
        aud: `${ORIGIN}/fhir`,
        sub: 'unknown-client',
      }),
    ],
    clients: [makeClient()],
  })
  const result = await runVerify(store, 'token')
  expect(Either.isLeft(result)).toBe(true)
})

test('JWT is rejected when client is disabled', async () => {
  const store = makeStubStore({
    jwks: [
      fakeJwk({
        iss: ORIGIN,
        aud: `${ORIGIN}/fhir`,
        sub: 'client-1',
      }),
    ],
    clients: [makeClient({ disabledAt: DateTime.unsafeNow() })],
  })
  const result = await runVerify(store, 'token')
  expect(Either.isLeft(result)).toBe(true)
})

test('JWT verifies when audience is the origin', async () => {
  const store = makeStubStore({
    jwks: [
      fakeJwk({
        iss: ORIGIN,
        aud: ORIGIN,
        sub: 'client-1',
      }),
    ],
    clients: [makeClient()],
  })
  const result = await runVerify(store, 'token')
  expect(Either.isRight(result)).toBe(true)
})

test('JWT is rejected when issuer mismatches origin', async () => {
  const store = makeStubStore({
    jwks: [
      fakeJwk({
        iss: 'https://other.example',
        aud: ORIGIN,
        sub: 'client-1',
      }),
    ],
    clients: [makeClient()],
  })
  const result = await runVerify(store, 'token')
  expect(Either.isLeft(result)).toBe(true)
})

test('JWT is rejected when sub is not a string', async () => {
  const store = makeStubStore({
    jwks: [
      fakeJwk({
        iss: ORIGIN,
        aud: ORIGIN,
        sub: 12345,
      }),
    ],
    clients: [makeClient()],
  })
  const result = await runVerify(store, 'token')
  expect(Either.isLeft(result)).toBe(true)
})
