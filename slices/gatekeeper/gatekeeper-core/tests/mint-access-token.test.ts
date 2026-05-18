import { DateTime, Duration, Effect, Either, Layer } from 'effect'
import { Origin } from 'navigation-core'
import { expect, test } from 'vite-plus/test'
import { mintAccessToken, verifyJwt } from '../src/internal/jwt.ts'
import { Client, type ClientRow, GatekeeperStore, SigningKey } from '../src/livestore/index.ts'
import { testingKey1 } from './fixtures/signing-keys.ts'
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
  signingKeys: ReadonlyArray<SigningKey.Type>
  clients: ReadonlyArray<ClientRow>
}): typeof GatekeeperStore.Service => {
  const clientMap = new Map(options.clients.map((c) => [c.clientId, c]))

  const query = (q: unknown): unknown => {
    if (q === SigningKey.queries.all$) return options.signingKeys
    const label = labelOf(q)
    const hash = hashOf(q)
    if (label === 'clientById' && hash !== undefined) {
      for (const clientId of clientMap.keys()) {
        if (Client.queries.byId$(clientId).hash === hash) {
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

const makeClient = (overrides: Partial<ClientRow> = {}): ClientRow => ({
  clientId: 'wildflower-host',
  name: 'Wildflower (host)',
  kind: 'public',
  redirectUris: [],
  allowedScopes: ['owner'],
  secretHash: null,
  registeredAt: DateTime.unsafeNow(),
  disabledAt: null,
  ...overrides,
})

test('mintAccessToken round-trips through verifyJwt', async () => {
  const signingKey = testingKey1
  const store = makeStubStore({
    signingKeys: [signingKey],
    clients: [makeClient()],
  })

  const token = await Effect.runPromise(
    mintAccessToken(signingKey, ORIGIN, {
      clientId: 'wildflower-host',
      scope: ['owner'],
      ttl: Duration.minutes(1),
    })
  )

  const result = await Effect.runPromise(
    verifyJwt(token).pipe(
      Effect.provide(GatekeeperStore.layerFrom(store)),
      Effect.provide(Layer.succeed(Origin, ORIGIN)),
      Effect.either
    )
  )

  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right.sub).toBe('wildflower-host')
    expect(result.right.iss).toBe(ORIGIN)
    expect(result.right.scope).toBe('owner')
  }
})

test('mintAccessToken issues a token whose verification fails when client is not registered', async () => {
  const signingKey = testingKey1
  const store = makeStubStore({
    signingKeys: [signingKey],
    clients: [],
  })

  const token = await Effect.runPromise(
    mintAccessToken(signingKey, ORIGIN, {
      clientId: 'wildflower-host',
      scope: ['owner'],
      ttl: Duration.minutes(1),
    })
  )

  const result = await Effect.runPromise(
    verifyJwt(token).pipe(
      Effect.provide(GatekeeperStore.layerFrom(store)),
      Effect.provide(Layer.succeed(Origin, ORIGIN)),
      Effect.either
    )
  )

  expect(Either.isLeft(result)).toBe(true)
})

test('mintAccessToken issues a token that fails verification once expired', async () => {
  const signingKey = testingKey1
  const store = makeStubStore({
    signingKeys: [signingKey],
    clients: [makeClient()],
  })

  const token = await Effect.runPromise(
    mintAccessToken(signingKey, ORIGIN, {
      clientId: 'wildflower-host',
      scope: ['owner'],
      ttl: Duration.seconds(-1),
    })
  )

  const result = await Effect.runPromise(
    verifyJwt(token).pipe(
      Effect.provide(GatekeeperStore.layerFrom(store)),
      Effect.provide(Layer.succeed(Origin, ORIGIN)),
      Effect.either
    )
  )

  expect(Either.isLeft(result)).toBe(true)
})

test('mintAccessToken includes patient claim when supplied', async () => {
  const signingKey = testingKey1
  const store = makeStubStore({
    signingKeys: [signingKey],
    clients: [makeClient({ clientId: 'smart-app', allowedScopes: ['patient/*.read'] })],
  })

  const token = await Effect.runPromise(
    mintAccessToken(signingKey, ORIGIN, {
      clientId: 'smart-app',
      scope: ['patient/*.read'],
      ttl: Duration.minutes(1),
      audience: `${ORIGIN}/fhir`,
      patient: 'patient-1',
    })
  )

  const result = await Effect.runPromise(
    verifyJwt(token).pipe(
      Effect.provide(GatekeeperStore.layerFrom(store)),
      Effect.provide(Layer.succeed(Origin, ORIGIN)),
      Effect.either
    )
  )

  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right.patient).toBe('patient-1')
    expect(result.right.aud).toBe(`${ORIGIN}/fhir`)
  }
})
