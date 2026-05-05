import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { DateTime, Effect, Layer, Schema } from 'effect'
import { Origin } from 'kitchen-sink'
import { expect, test } from 'vite-plus/test'

const JsonObjectSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const decodeJsonObject = Schema.decodeUnknownSync(JsonObjectSchema)
const readJsonObject = async (response: Response): Promise<Record<string, unknown>> => {
  const raw: unknown = await response.json()
  return decodeJsonObject(raw)
}
import { type GatekeeperStore, makeGatekeeperStoreLayer } from '../src/contexts/gatekeeper-store.ts'
import { GatekeeperApi } from '../src/http-api-definition/index.ts'
import {
  GatekeeperApiLive,
  RequireAuthMiddlewareLive,
} from '../src/http-api-implementation/index.ts'
import { mintAccessToken } from '../src/internal/jwt.ts'
import {
  AuthorizationRequests,
  type AuthorizationRequestRow,
  Clients,
  type ClientRow,
  SigningKey,
  SigningKeys,
} from '../src/livestore/index.ts'

const ORIGIN = 'http://localhost:8787'

const StubGatekeeperPagesLive = HttpApiBuilder.group(
  GatekeeperApi,
  'gatekeeper-pages',
  (handlers) =>
    handlers
      .handle('OAuthPollingPage', () => Effect.succeed('<!doctype html><html></html>'))
      .handle('OAuthConsentPage', () => Effect.succeed('<!doctype html><html></html>'))
      .handle('DeviceEntryPage', () => Effect.succeed('<!doctype html><html></html>'))
      .handle('DeviceConsentPage', () => Effect.succeed('<!doctype html><html></html>'))
).pipe(Layer.provide(RequireAuthMiddlewareLive))

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

const decodeDeviceStartedArgs = Schema.decodeUnknownSync(
  AuthorizationRequests.events.deviceAuthorizationRequestStarted.schema
)
const decodeApprovedArgs = Schema.decodeUnknownSync(
  AuthorizationRequests.events.authorizationRequestApproved.schema
)
const decodeDeniedArgs = Schema.decodeUnknownSync(
  AuthorizationRequests.events.authorizationRequestDenied.schema
)
const decodePolledArgs = Schema.decodeUnknownSync(
  AuthorizationRequests.events.deviceAuthorizationPolled.schema
)

type StoreOpts = {
  signingKeys: ReadonlyArray<SigningKey>
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
    if (q === SigningKeys.queries.all$) return opts.signingKeys
    const label = labelOf(q)
    const hash = hashOf(q)

    if (label === 'activeSigningKey') return opts.signingKeys[0] ?? null

    if (label === 'clientById' && hash !== undefined) {
      for (const clientId of clientMap.keys()) {
        if (Clients.queries.byId$(clientId).hash === hash) {
          return clientMap.get(clientId) ?? null
        }
      }
      return null
    }

    if (label === 'authorizationRequestById' && hash !== undefined) {
      for (const id of requestRows.keys()) {
        if (AuthorizationRequests.queries.byId$(id).hash === hash) {
          return requestRows.get(id) ?? null
        }
      }
      return null
    }

    if (label === 'authorizationRequestByUserCode' && hash !== undefined) {
      for (const row of requestRows.values()) {
        if (row.userCode == null) continue
        if (AuthorizationRequests.queries.byUserCode$(row.userCode).hash === hash) {
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
          const args = decodeDeviceStartedArgs(event.args)
          requestRows.set(args.id, {
            id: args.id,
            flow: 'device_code',
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
          const args = decodeApprovedArgs(event.args)
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
          const args = decodeDeniedArgs(event.args)
          const existing = requestRows.get(args.id)
          if (existing !== undefined) {
            requestRows.set(args.id, { ...existing, status: 'denied' })
          }
          break
        }
        case 'v1.DeviceAuthorizationPolled': {
          const args = decodePolledArgs(event.args)
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
    Layer.provide(StubGatekeeperPagesLive),
    Layer.provide(makeGatekeeperStoreLayer(store)),
    Layer.provide(Layer.succeed(Origin, ORIGIN))
  )
  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

test('POST /oauth/device_authorization issues device_code + user_code', async () => {
  const signingKey = await SigningKey.generate()
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
    expect(typeof body['device_code']).toBe('string')
    expect(body['user_code']).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
    expect(body['verification_uri']).toBe(`${ORIGIN}/access/devices`)
    expect(body['verification_uri_complete']).toBe(
      `${ORIGIN}/access/devices?user_code=${String(body['user_code'])}`
    )
    expect(body['expires_in']).toBe(300)
    expect(body['interval']).toBe(5)
  } finally {
    await dispose()
  }
})

test('POST /oauth/device_authorization rejects unknown client', async () => {
  const signingKey = await SigningKey.generate()
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
  const signingKey = await SigningKey.generate()
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
  const signingKey = await SigningKey.generate()
  const requestedAt = DateTime.unsafeNow()
  const expiresAt = DateTime.addDuration(requestedAt, '5 minutes')
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    flow: 'device_code',
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
  const signingKey = await SigningKey.generate()
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    flow: 'device_code',
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
  const signingKey = await SigningKey.generate()
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    flow: 'device_code',
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
  const signingKey = await SigningKey.generate()
  const requestedAt = DateTime.unsafeNow()
  const expiresAt = DateTime.addDuration(requestedAt, '5 minutes')
  const approved: AuthorizationRequestRow = {
    id: 'dev-1',
    flow: 'device_code',
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

test('GET /access/devices/:userCode returns the pending consent for an owner', async () => {
  const signingKey = await SigningKey.generate()
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    flow: 'device_code',
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
      ttlSeconds: 60,
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
  const signingKey = await SigningKey.generate()
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    flow: 'device_code',
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
      ttlSeconds: 60,
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

    // Subsequent token exchange should now succeed.
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

test('POST /access/devices/:userCode/deny without auth is rejected', async () => {
  const signingKey = await SigningKey.generate()
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    flow: 'device_code',
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
  const signingKey = await SigningKey.generate()
  // Pretend the row was polled 1 second ago — under the 5-second interval.
  const pending: AuthorizationRequestRow = {
    id: 'dev-1',
    flow: 'device_code',
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
