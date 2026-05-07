import { DateTime, Effect, Either, Layer } from 'effect'
import * as jose from 'jose'
import { Origin } from 'kitchen-sink'
import { expect, test } from 'vite-plus/test'
import { type GatekeeperStore, makeGatekeeperStoreLayer } from '../src/contexts/gatekeeper-store.ts'
import { verifyJwt } from '../src/internal/jwt.ts'
import { Client, type ClientRow, SigningKey } from '../src/livestore/index.ts'
import { testingKey1, testingKey2 } from './fixtures/signing-keys.ts'

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
  clients?: ReadonlyArray<ClientRow>
}): typeof GatekeeperStore.Service => {
  const { signingKeys, clients = [] } = options
  const clientMap = new Map(clients.map((c) => [c.clientId, c]))

  const query = (q: unknown): unknown => {
    if (q === SigningKey.queries.all$) return signingKeys
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

// `jose.importJWK` returns `CryptoKey | Uint8Array`. For RSA JWKs it's
// always `CryptoKey`, so we runtime-check rather than unsafely cast.
const importRsaJwk = async (jwk: jose.JWK): Promise<jose.CryptoKey> => {
  const imported = await jose.importJWK(jwk)
  if (!(imported instanceof CryptoKey)) {
    throw new Error('Expected jose.importJWK to return a CryptoKey for an RSA JWK')
  }
  return imported
}

// Sign an arbitrary payload with a given SigningKey via raw `jose.SignJWT`.
// `mintAccessToken`'s typed signature won't allow non-string `sub`,
// custom `aud` shapes, or explicit `exp`, so we go through jose directly.
const signWith = async (key: SigningKey.Type, payload: jose.JWTPayload): Promise<string> => {
  const joseKey = await importRsaJwk(SigningKey.privateJwk(key))
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .sign(joseKey)
}

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
  const key = testingKey1
  const token = await signWith(key, {
    iss: ORIGIN,
    aud: `${ORIGIN}/fhir`,
    sub: 'client-1',
  })
  const store = makeStubStore({
    signingKeys: [key],
    clients: [makeClient()],
  })
  const result = await runVerify(store, token)
  expect(Either.isRight(result)).toBe(true)
})

test('JWT is rejected when sub does not match any client', async () => {
  const key = testingKey1
  const token = await signWith(key, {
    iss: ORIGIN,
    aud: `${ORIGIN}/fhir`,
    sub: 'unknown-client',
  })
  const store = makeStubStore({
    signingKeys: [key],
    clients: [makeClient()],
  })
  const result = await runVerify(store, token)
  expect(Either.isLeft(result)).toBe(true)
})

test('JWT is rejected when client is disabled', async () => {
  const key = testingKey1
  const token = await signWith(key, {
    iss: ORIGIN,
    aud: `${ORIGIN}/fhir`,
    sub: 'client-1',
  })
  const store = makeStubStore({
    signingKeys: [key],
    clients: [makeClient({ disabledAt: DateTime.unsafeNow() })],
  })
  const result = await runVerify(store, token)
  expect(Either.isLeft(result)).toBe(true)
})

test('JWT verifies when audience is the origin', async () => {
  const key = testingKey1
  const token = await signWith(key, {
    iss: ORIGIN,
    aud: ORIGIN,
    sub: 'client-1',
  })
  const store = makeStubStore({
    signingKeys: [key],
    clients: [makeClient()],
  })
  const result = await runVerify(store, token)
  expect(Either.isRight(result)).toBe(true)
})

test('JWT is rejected when issuer mismatches origin', async () => {
  const key = testingKey1
  const token = await signWith(key, {
    iss: 'https://other.example',
    aud: ORIGIN,
    sub: 'client-1',
  })
  const store = makeStubStore({
    signingKeys: [key],
    clients: [makeClient()],
  })
  const result = await runVerify(store, token)
  expect(Either.isLeft(result)).toBe(true)
})

test('JWT is rejected when sub is not a string', async () => {
  const key = testingKey1
  // `jose.JWTPayload.sub` is typed `string | undefined`; we deliberately
  // bypass that here to exercise the runtime guard in `verifyJwt`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const token = await signWith(key, {
    iss: ORIGIN,
    aud: ORIGIN,
    sub: 12345,
  } as unknown as jose.JWTPayload)
  const store = makeStubStore({
    signingKeys: [key],
    clients: [makeClient()],
  })
  const result = await runVerify(store, token)
  expect(Either.isLeft(result)).toBe(true)
})

test('JWT is rejected when exp is in the past', async () => {
  const key = testingKey1
  const past = Math.floor(Date.now() / 1000) - 60
  const token = await signWith(key, {
    iss: ORIGIN,
    aud: ORIGIN,
    sub: 'client-1',
    exp: past,
  })
  const store = makeStubStore({
    signingKeys: [key],
    clients: [makeClient()],
  })
  const result = await runVerify(store, token)
  expect(Either.isLeft(result)).toBe(true)
})

test('JWT is rejected when audience is not in accepted set', async () => {
  const key = testingKey1
  const token = await signWith(key, {
    iss: ORIGIN,
    aud: 'https://malicious.example',
    sub: 'client-1',
  })
  const store = makeStubStore({
    signingKeys: [key],
    clients: [makeClient()],
  })
  const result = await runVerify(store, token)
  expect(Either.isLeft(result)).toBe(true)
})

test('JWT is rejected when no signing keys are present', async () => {
  // verifyJwt now surfaces the empty-keys path as InternalServerError
  // (server misconfiguration), not Unauthorized. The shape we assert on
  // is `Either.isLeft`, which still holds for either failure type.
  const store = makeStubStore({ signingKeys: [], clients: [makeClient()] })
  const result = await runVerify(store, 'token')
  expect(Either.isLeft(result)).toBe(true)
})

test('JWT is verified when one of multiple signing keys can verify it', async () => {
  // Sign with key B, present `[key A, key B]`. verifyAgainstAnyKey
  // iterates every key — key A's signature check fails, key B's
  // succeeds. This is the rotation scenario.
  const keyA = testingKey1
  const keyB = testingKey2
  const token = await signWith(keyB, {
    iss: ORIGIN,
    aud: ORIGIN,
    sub: 'client-1',
  })
  const store = makeStubStore({
    signingKeys: [keyA, keyB],
    clients: [makeClient()],
  })
  const result = await runVerify(store, token)
  expect(Either.isRight(result)).toBe(true)
})

test('JWT is verified when audience is an array containing an accepted entry', async () => {
  const key = testingKey1
  const token = await signWith(key, {
    iss: ORIGIN,
    aud: ['https://other.example', `${ORIGIN}/fhir`],
    sub: 'client-1',
  })
  const store = makeStubStore({
    signingKeys: [key],
    clients: [makeClient()],
  })
  const result = await runVerify(store, token)
  expect(Either.isRight(result)).toBe(true)
})
