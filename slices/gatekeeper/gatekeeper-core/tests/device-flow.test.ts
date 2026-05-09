import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { DateTime, Duration, Effect, Layer, Schema } from 'effect'
import { Origin } from 'kitchen-sink'
import { cryptoRandomCounter } from 'kitchen-sink/crypto-random'
import { expect, test } from 'vite-plus/test'

const JsonObjectSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const decodeJsonObject = Schema.decodeUnknownSync(JsonObjectSchema)
const readJsonObject = async (response: Response): Promise<Record<string, unknown>> => {
  const raw: unknown = await response.json()
  return decodeJsonObject(raw)
}
import { type GatekeeperStore, makeGatekeeperStoreLayer } from '../src/contexts/gatekeeper-store.ts'
import { GatekeeperApiLive } from '../src/http-api-implementation/index.ts'
import { mintAccessToken } from '../src/internal/jwt.ts'
import {
  AuthorizationRequest,
  type AuthorizationRequestRow,
  Client,
  type ClientRow,
  SigningKey,
} from '../src/livestore/index.ts'
import { testingKey1 } from './fixtures/signing-keys.ts'

const ORIGIN = 'http://localhost:8787'

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

type CommittedEvent = { name: string; args: Record<string, unknown> }

// Event factories pass args in decoded form (DateTime.Utc, not ISO strings).
type DeviceStartedArgs =
  typeof AuthorizationRequest.events.deviceAuthorizationRequestStarted.schema.Type
type ApprovedArgs = typeof AuthorizationRequest.events.authorizationRequestApproved.schema.Type
type DeniedArgs = typeof AuthorizationRequest.events.authorizationRequestDenied.schema.Type
type ExpiredArgs = typeof AuthorizationRequest.events.authorizationRequestExpired.schema.Type
type PolledArgs = typeof AuthorizationRequest.events.deviceAuthorizationPolled.schema.Type

type StoreOpts = {
  signingKeys: ReadonlyArray<SigningKey.Type>
  clients: ReadonlyArray<ClientRow>
  authorizationRequests?: ReadonlyArray<AuthorizationRequestRow>
}

const makeStore = (opts: StoreOpts): typeof GatekeeperStore.Service => {
  const clientMap = new Map(opts.clients.map((c) => [c.clientId, c]))
  const requestRows = new Map<string, AuthorizationRequestRow>()
  for (const row of opts.authorizationRequests ?? []) {
    requestRows.set(row.id, row)
  }

  const query = (q: unknown): unknown => {
    if (q === SigningKey.queries.all$) return opts.signingKeys
    const label = labelOf(q)
    const hash = hashOf(q)

    if (label === 'activeSigningKey') return opts.signingKeys[0] ?? null

    if (label === 'clientById' && hash !== undefined) {
      for (const clientId of clientMap.keys()) {
        if (Client.queries.byId$(clientId).hash === hash) {
          return clientMap.get(clientId) ?? null
        }
      }
      return null
    }

    if (label === 'authorizationRequestById' && hash !== undefined) {
      for (const id of requestRows.keys()) {
        if (AuthorizationRequest.queries.byId$(id).hash === hash) {
          return requestRows.get(id) ?? null
        }
      }
      return null
    }

    if (label === 'authorizationRequestByUserCode' && hash !== undefined) {
      for (const row of requestRows.values()) {
        if (row.userCode == null) continue
        if (AuthorizationRequest.queries.byUserCode$(row.userCode).hash === hash) {
          return row
        }
      }
      return null
    }

    return []
  }

  const commit = (...events: ReadonlyArray<CommittedEvent>): void => {
    for (const event of events) {
      switch (event.name) {
        case 'v1.DeviceAuthorizationRequestStarted': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as unknown as DeviceStartedArgs
          requestRows.set(args.id, {
            id: args.id,
            grantType: 'device_code',
            clientId: args.clientId,
            requestedScopes: args.requestedScopes,
            codeChallenge: null,
            codeChallengeMethod: null,
            redirectUri: null,
            clientState: null,
            userCode: args.userCode,
            preApprovedScopes: null,
            requestedAt: args.requestedAt,
            expiresAt: args.expiresAt,
            lastPolledAt: null,
            status: 'pending',
            grantedScopes: null,
            patient: null,
          })
          break
        }
        case 'v1.AuthorizationRequestApproved': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as unknown as ApprovedArgs
          const existing = requestRows.get(args.id)
          if (existing !== undefined) {
            requestRows.set(args.id, {
              ...existing,
              status: 'approved',
              grantedScopes: args.grantedScopes,
              patient: args.patient,
            })
          }
          break
        }
        case 'v1.AuthorizationRequestDenied': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as unknown as DeniedArgs
          const existing = requestRows.get(args.id)
          if (existing !== undefined) {
            requestRows.set(args.id, { ...existing, status: 'denied' })
          }
          break
        }
        case 'v1.AuthorizationRequestExpired': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as unknown as ExpiredArgs
          const existing = requestRows.get(args.id)
          if (existing !== undefined) {
            requestRows.set(args.id, { ...existing, status: 'expired' })
          }
          break
        }
        case 'v1.DeviceAuthorizationPolled': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as unknown as PolledArgs
          const existing = requestRows.get(args.id)
          if (existing !== undefined) {
            requestRows.set(args.id, { ...existing, lastPolledAt: args.polledAt })
          }
          break
        }
        default:
          break
      }
    }
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { query, commit } as unknown as typeof GatekeeperStore.Service
}

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

const createHandler = (
  store: typeof GatekeeperStore.Service
): ReturnType<typeof HttpApiBuilder.toWebHandler> => {
  const apiLive = GatekeeperApiLive.pipe(
    Layer.provide(makeGatekeeperStoreLayer(store)),
    Layer.provide(Layer.succeed(Origin, ORIGIN)),
    Layer.provide(cryptoRandomCounter({ uuidPrefix: 'device' }))
  )
  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

test('POST /oauth/device_authorization issues device_code + user_code', async () => {
  const signingKey = testingKey1
  const store = makeStore({ signingKeys: [signingKey], clients: [makeClient()] })
  const { handler, dispose } = createHandler(store)

  try {
    const response = await handler(
      new Request(`${ORIGIN}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'wildflower-host', scope: 'owner' }),
      })
    )
    expect(response.status).toBe(200)
    const body = await readJsonObject(response)
    expect(body['device_code']).toBe('device-0001')
    expect(body['user_code']).toBe('BCDF-GHJK')
    expect(body['verification_uri']).toBe(`${ORIGIN}/gatekeeper/devices`)
    expect(body['verification_uri_complete']).toBe(
      `${ORIGIN}/gatekeeper/devices?user_code=BCDF-GHJK`
    )
    expect(body['expires_in']).toBe(300)
    expect(body['interval']).toBe(5)
  } finally {
    await dispose()
  }
})

test('POST /oauth/device_authorization rejects unknown client', async () => {
  const signingKey = testingKey1
  const store = makeStore({ signingKeys: [signingKey], clients: [] })
  const { handler, dispose } = createHandler(store)
  try {
    const response = await handler(
      new Request(`${ORIGIN}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'unknown', scope: 'owner' }),
      })
    )
    expect(response.status).toBe(401)
  } finally {
    await dispose()
  }
})

test('POST /oauth/device_authorization rejects scope outside client allowedScopes', async () => {
  const signingKey = testingKey1
  const store = makeStore({
    signingKeys: [signingKey],
    clients: [makeClient({ allowedScopes: ['owner'] })],
  })
  const { handler, dispose } = createHandler(store)
  try {
    const response = await handler(
      new Request(`${ORIGIN}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'wildflower-host', scope: 'patient/*.read' }),
      })
    )
    expect(response.status).toBe(400)
  } finally {
    await dispose()
  }
})

test('device-flow token exchange returns authorization_pending while consent is pending', async () => {
  const signingKey = testingKey1
  const requestedAt = DateTime.unsafeNow()
  const expiresAt = DateTime.addDuration(requestedAt, '5 minutes')
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    grantType: 'device_code',
    clientId: 'wildflower-host',
    requestedScopes: ['owner'],
    codeChallenge: null,
    codeChallengeMethod: null,
    redirectUri: null,
    clientState: null,
    userCode: 'BCDF-GHJK',
    preApprovedScopes: null,
    requestedAt,
    expiresAt,
    lastPolledAt: null,
    status: 'pending',
    grantedScopes: null,
    patient: null,
  }
  const store = makeStore({
    signingKeys: [signingKey],
    clients: [makeClient()],
    authorizationRequests: [pending],
  })
  const { handler, dispose } = createHandler(store)

  try {
    const response = await handler(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'wildflower-host',
          device_code: 'dev-1',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })
    )
    expect(response.status).toBe(400)
    const body = await readJsonObject(response)
    expect(body['error']).toBe('authorization_pending')
  } finally {
    await dispose()
  }
})

test('device-flow token exchange returns access_denied when consent was denied', async () => {
  const signingKey = testingKey1
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    grantType: 'device_code',
    clientId: 'wildflower-host',
    requestedScopes: ['owner'],
    codeChallenge: null,
    codeChallengeMethod: null,
    redirectUri: null,
    clientState: null,
    userCode: 'BCDF-GHJK',
    preApprovedScopes: null,
    requestedAt: DateTime.unsafeNow(),
    expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '5 minutes'),
    lastPolledAt: null,
    status: 'denied',
    grantedScopes: null,
    patient: null,
  }
  const store = makeStore({
    signingKeys: [signingKey],
    clients: [makeClient()],
    authorizationRequests: [pending],
  })
  const { handler, dispose } = createHandler(store)

  try {
    const response = await handler(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'wildflower-host',
          device_code: 'dev-1',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })
    )
    const body = await readJsonObject(response)
    expect(body['error']).toBe('access_denied')
  } finally {
    await dispose()
  }
})

test('device-flow token exchange returns expired_token after expiry', async () => {
  const signingKey = testingKey1
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    grantType: 'device_code',
    clientId: 'wildflower-host',
    requestedScopes: ['owner'],
    codeChallenge: null,
    codeChallengeMethod: null,
    redirectUri: null,
    clientState: null,
    userCode: 'BCDF-GHJK',
    preApprovedScopes: null,
    requestedAt: DateTime.subtract(DateTime.unsafeNow(), { hours: 1 }),
    expiresAt: DateTime.subtract(DateTime.unsafeNow(), { minutes: 5 }),
    lastPolledAt: null,
    status: 'pending',
    grantedScopes: null,
    patient: null,
  }
  const store = makeStore({
    signingKeys: [signingKey],
    clients: [makeClient()],
    authorizationRequests: [pending],
  })
  const { handler, dispose } = createHandler(store)

  try {
    const response = await handler(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'wildflower-host',
          device_code: 'dev-1',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })
    )
    const body = await readJsonObject(response)
    expect(body['error']).toBe('expired_token')
  } finally {
    await dispose()
  }
})

test('device-flow token exchange mints token after approval', async () => {
  const signingKey = testingKey1
  const requestedAt = DateTime.unsafeNow()
  const expiresAt = DateTime.addDuration(requestedAt, '5 minutes')
  const approved: AuthorizationRequestRow = {
    id: 'dev-1',
    grantType: 'device_code',
    clientId: 'wildflower-host',
    requestedScopes: ['owner'],
    codeChallenge: null,
    codeChallengeMethod: null,
    redirectUri: null,
    clientState: null,
    userCode: 'BCDF-GHJK',
    preApprovedScopes: null,
    requestedAt,
    expiresAt,
    lastPolledAt: null,
    status: 'approved',
    grantedScopes: ['owner'],
    patient: null,
  }
  const store = makeStore({
    signingKeys: [signingKey],
    clients: [makeClient()],
    authorizationRequests: [approved],
  })
  const { handler, dispose } = createHandler(store)

  try {
    const response = await handler(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'wildflower-host',
          device_code: 'dev-1',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })
    )
    expect(response.status).toBe(200)
    const body = await readJsonObject(response)
    expect(typeof body['access_token']).toBe('string')
    expect(body['token_type']).toBe('Bearer')
    expect(body['scope']).toBe('owner')
  } finally {
    await dispose()
  }
})

test('device_code is single-use: a second token poll returns expired_token', async () => {
  const signingKey = testingKey1
  const approved: AuthorizationRequestRow = {
    id: 'dev-1',
    grantType: 'device_code',
    clientId: 'wildflower-host',
    requestedScopes: ['owner'],
    codeChallenge: null,
    codeChallengeMethod: null,
    redirectUri: null,
    clientState: null,
    userCode: 'BCDF-GHJK',
    preApprovedScopes: null,
    requestedAt: DateTime.unsafeNow(),
    expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '5 minutes'),
    lastPolledAt: null,
    status: 'approved',
    grantedScopes: ['owner'],
    patient: null,
  }
  const store = makeStore({
    signingKeys: [signingKey],
    clients: [makeClient()],
    authorizationRequests: [approved],
  })
  const { handler, dispose } = createHandler(store)

  try {
    const first = await handler(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'wildflower-host',
          device_code: 'dev-1',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })
    )
    expect(first.status).toBe(200)

    // Second exchange must reject: the first transition should have flipped status to 'expired'.
    const second = await handler(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'wildflower-host',
          device_code: 'dev-1',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })
    )
    expect(second.status).toBe(400)
    const body = await readJsonObject(second)
    expect(body['error']).toBe('expired_token')
  } finally {
    await dispose()
  }
})

test('GET /access/devices/:userCode returns the pending consent for an owner', async () => {
  const signingKey = testingKey1
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    grantType: 'device_code',
    clientId: 'wildflower-host',
    requestedScopes: ['owner'],
    codeChallenge: null,
    codeChallengeMethod: null,
    redirectUri: null,
    clientState: null,
    userCode: 'BCDF-GHJK',
    preApprovedScopes: null,
    requestedAt: DateTime.unsafeNow(),
    expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '5 minutes'),
    lastPolledAt: null,
    status: 'pending',
    grantedScopes: null,
    patient: null,
  }
  const store = makeStore({
    signingKeys: [signingKey],
    clients: [makeClient()],
    authorizationRequests: [pending],
  })
  const { handler, dispose } = createHandler(store)
  const ownerToken = await Effect.runPromise(
    mintAccessToken(signingKey, ORIGIN, {
      clientId: 'wildflower-host',
      scope: ['owner'],
      ttl: Duration.minutes(1),
    })
  )

  try {
    const response = await handler(
      new Request(`${ORIGIN}/access/devices/BCDF-GHJK`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    )
    expect(response.status).toBe(200)
    const body = await readJsonObject(response)
    expect(body['userCode']).toBe('BCDF-GHJK')
    expect(body['clientId']).toBe('wildflower-host')
    expect(body['clientName']).toBe('Wildflower (host)')
    expect(body['requestedScopes']).toEqual(['owner'])
  } finally {
    await dispose()
  }
})

test('POST /access/devices/:userCode/approve flips status to approved', async () => {
  const signingKey = testingKey1
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    grantType: 'device_code',
    clientId: 'wildflower-host',
    requestedScopes: ['owner'],
    codeChallenge: null,
    codeChallengeMethod: null,
    redirectUri: null,
    clientState: null,
    userCode: 'BCDF-GHJK',
    preApprovedScopes: null,
    requestedAt: DateTime.unsafeNow(),
    expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '5 minutes'),
    lastPolledAt: null,
    status: 'pending',
    grantedScopes: null,
    patient: null,
  }
  const store = makeStore({
    signingKeys: [signingKey],
    clients: [makeClient()],
    authorizationRequests: [pending],
  })
  const { handler, dispose } = createHandler(store)
  const ownerToken = await Effect.runPromise(
    mintAccessToken(signingKey, ORIGIN, {
      clientId: 'wildflower-host',
      scope: ['owner'],
      ttl: Duration.minutes(1),
    })
  )

  try {
    const response = await handler(
      new Request(`${ORIGIN}/access/devices/BCDF-GHJK/approve`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ approvedScopes: ['owner'] }),
      })
    )
    expect(response.status).toBe(200)
    const body = await readJsonObject(response)
    expect(body['status']).toBe('approved')

    const tokenResponse = await handler(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'wildflower-host',
          device_code: 'dev-1',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })
    )
    expect(tokenResponse.status).toBe(200)
  } finally {
    await dispose()
  }
})

test('POST /access/devices/:userCode/approve with empty granted scopes routes through deny', async () => {
  const signingKey = testingKey1
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    grantType: 'device_code',
    clientId: 'wildflower-host',
    requestedScopes: ['owner'],
    codeChallenge: null,
    codeChallengeMethod: null,
    redirectUri: null,
    clientState: null,
    userCode: 'BCDF-GHJK',
    preApprovedScopes: null,
    requestedAt: DateTime.unsafeNow(),
    expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '5 minutes'),
    lastPolledAt: null,
    status: 'pending',
    grantedScopes: null,
    patient: null,
  }
  const store = makeStore({
    signingKeys: [signingKey],
    clients: [makeClient()],
    authorizationRequests: [pending],
  })
  const { handler, dispose } = createHandler(store)
  const ownerToken = await Effect.runPromise(
    mintAccessToken(signingKey, ORIGIN, {
      clientId: 'wildflower-host',
      scope: ['owner'],
      ttl: Duration.minutes(1),
    })
  )

  try {
    // Empty `approvedScopes` is treated as a denial; otherwise the client gets a scope='' token.
    const response = await handler(
      new Request(`${ORIGIN}/access/devices/BCDF-GHJK/approve`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ approvedScopes: [] }),
      })
    )
    expect(response.status).toBe(200)
    const body = await readJsonObject(response)
    expect(body['status']).toBe('denied')

    const tokenResponse = await handler(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'wildflower-host',
          device_code: 'dev-1',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })
    )
    expect(tokenResponse.status).toBe(400)
    const tokenBody = await readJsonObject(tokenResponse)
    expect(tokenBody['error']).toBe('access_denied')
  } finally {
    await dispose()
  }
})

test('POST /access/devices/:userCode/deny without auth is rejected', async () => {
  const signingKey = testingKey1
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    grantType: 'device_code',
    clientId: 'wildflower-host',
    requestedScopes: ['owner'],
    codeChallenge: null,
    codeChallengeMethod: null,
    redirectUri: null,
    clientState: null,
    userCode: 'BCDF-GHJK',
    preApprovedScopes: null,
    requestedAt: DateTime.unsafeNow(),
    expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '5 minutes'),
    lastPolledAt: null,
    status: 'pending',
    grantedScopes: null,
    patient: null,
  }
  const store = makeStore({
    signingKeys: [signingKey],
    clients: [makeClient()],
    authorizationRequests: [pending],
  })
  const { handler, dispose } = createHandler(store)

  try {
    const response = await handler(
      new Request(`${ORIGIN}/access/devices/BCDF-GHJK/deny`, { method: 'POST' })
    )
    expect(response.status).toBe(401)
  } finally {
    await dispose()
  }
})

test('device-flow token exchange returns slow_down when polled within interval', async () => {
  const signingKey = testingKey1
  // Last poll 1s ago, under the 5s interval.
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    grantType: 'device_code',
    clientId: 'wildflower-host',
    requestedScopes: ['owner'],
    codeChallenge: null,
    codeChallengeMethod: null,
    redirectUri: null,
    clientState: null,
    userCode: 'BCDF-GHJK',
    preApprovedScopes: null,
    requestedAt: DateTime.unsafeNow(),
    expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '5 minutes'),
    lastPolledAt: DateTime.subtract(DateTime.unsafeNow(), { seconds: 1 }),
    status: 'pending',
    grantedScopes: null,
    patient: null,
  }
  const store = makeStore({
    signingKeys: [signingKey],
    clients: [makeClient()],
    authorizationRequests: [pending],
  })
  const { handler, dispose } = createHandler(store)

  try {
    const response = await handler(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'wildflower-host',
          device_code: 'dev-1',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })
    )
    const body = await readJsonObject(response)
    expect(body['error']).toBe('slow_down')
  } finally {
    await dispose()
  }
})
