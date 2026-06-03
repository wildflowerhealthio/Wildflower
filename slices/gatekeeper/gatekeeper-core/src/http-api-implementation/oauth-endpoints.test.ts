import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { DateTime, Effect, Layer } from 'effect'
import * as jose from 'jose'
import { cryptoRandomCounter } from 'kitchen-sink/crypto-random'
import { Origin } from 'navigation-core'
import { expect, test } from 'vite-plus/test'
import { computeCodeChallenge } from '../internal/pkce.ts'
import {
  AuthorizationCode,
  type AuthorizationCodeRow,
  AuthorizationRequest,
  type AuthorizationRequestRow,
  Client,
  type ClientRow,
  GatekeeperStore,
  Grant,
  SigningKey,
} from '../livestore/index.ts'
import { testingKey1 } from '../test-fixtures/signing-keys.ts'
import { GatekeeperApiLive } from './index.ts'
const sharedSigningKey = testingKey1

type MockGrant = {
  id: string
  clientId: string
  scopes: ReadonlyArray<string>
  redirectUri: string
  grantedAt: DateTime.Utc
  lastUsedAt: DateTime.Utc | null
  patient: string | null
}

type MockStoreOptions = {
  signingKeys?: ReadonlyArray<SigningKey.Type>
  clients?: ReadonlyArray<ClientRow>
  grants?: ReadonlyArray<MockGrant>
  authorizationRequests?: ReadonlyArray<AuthorizationRequestRow>
  authorizationCodes?: ReadonlyArray<AuthorizationCodeRow>
}

const makeClient = (overrides: Partial<ClientRow> = {}): ClientRow => ({
  clientId: 'test-client',
  name: 'Test Client',
  kind: 'public',
  redirectUris: ['https://example.com/cb', 'https://app.example/callback'],
  allowedScopes: ['patient/*.read', 'launch'],
  secretHash: null,
  registeredAt: DateTime.unsafeNow(),
  disabledAt: null,
  ...overrides,
})

type CommittedEvent = { name: string; args: Record<string, unknown> }

// Identify a LiveQueryDef by its stable `hash` (query + bind values).
const queryHash = (q: unknown): string | undefined => {
  if (typeof q === 'object' && q !== null && 'hash' in q && typeof q.hash === 'string') {
    return q.hash
  }
  return undefined
}

const queryLabel = (q: unknown): string | undefined => {
  if (typeof q === 'object' && q !== null && 'label' in q && typeof q.label === 'string') {
    return q.label
  }
  return undefined
}

const makeStore = ({
  signingKeys = [],
  clients = [],
  grants = [],
  authorizationRequests = [],
  authorizationCodes = [],
}: MockStoreOptions): typeof GatekeeperStore.Service => {
  const clientRows = new Map<string, ClientRow>()
  for (const row of clients) {
    clientRows.set(row.clientId, row)
  }
  const requestRows = new Map<string, AuthorizationRequestRow>()
  for (const row of authorizationRequests) {
    requestRows.set(row.id, row)
  }
  const codeRows = new Map<string, AuthorizationCodeRow>()
  for (const row of authorizationCodes) {
    codeRows.set(row.code, row)
  }
  const grantRows: MockGrant[] = [...grants]

  const query = (q: unknown): unknown => {
    if (q === SigningKey.queries.all$) {
      return signingKeys
    }

    const label = queryLabel(q)
    const hash = queryHash(q)

    if (label === 'authorizationRequestById' && hash !== undefined) {
      for (const id of requestRows.keys()) {
        if (AuthorizationRequest.queries.byId$(id).hash === hash) {
          return requestRows.get(id) ?? null
        }
      }
      return null
    }

    if (label === 'authorizationCodeByCode' && hash !== undefined) {
      for (const code of codeRows.keys()) {
        if (AuthorizationCode.queries.byCode$(code).hash === hash) {
          return codeRows.get(code) ?? null
        }
      }
      return null
    }

    if (label === 'authorizationCodeByRequestId' && hash !== undefined) {
      for (const requestId of new Set([...codeRows.values()].map((r) => r.requestId))) {
        if (AuthorizationCode.queries.byRequestId$(requestId).hash === hash) {
          return [...codeRows.values()].find((r) => r.requestId === requestId) ?? null
        }
      }
      return null
    }

    if (label === 'grantsByClientId' && hash !== undefined) {
      const seenClientIds = new Set(grantRows.map((g) => g.clientId))
      for (const clientId of seenClientIds) {
        if (Grant.queries.byClientId$(clientId).hash === hash) {
          return grantRows.filter((g) => g.clientId === clientId)
        }
      }
      return []
    }

    if (label === 'grantByClientIdAndRedirectUri' && hash !== undefined) {
      for (const g of grantRows) {
        if (Grant.queries.byClientIdAndRedirectUri$(g.clientId, g.redirectUri).hash === hash) {
          return g
        }
      }
      return null
    }

    if (label === 'clientById' && hash !== undefined) {
      for (const clientId of clientRows.keys()) {
        if (Client.queries.byId$(clientId).hash === hash) {
          return clientRows.get(clientId) ?? null
        }
      }
      return null
    }

    if (label === 'activeSigningKey') {
      return signingKeys[0] ?? null
    }

    if (label === 'authorizationRequests') return [...requestRows.values()]
    if (label === 'authorizationCodes') return [...codeRows.values()]
    if (label === 'authorizationRequestsExpired' || label === 'authorizationCodesExpired') {
      return []
    }

    return grantRows
  }

  const commit = (...events: ReadonlyArray<CommittedEvent>): void => {
    for (const event of events) {
      switch (event.name) {
        case 'v1.AuthorizationRequestStarted': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as {
            id: string
            clientId: string
            requestedScopes: ReadonlyArray<string>
            codeChallenge: string
            codeChallengeMethod: 'S256'
            redirectUri: string
            clientState: string
            preApprovedScopes: ReadonlyArray<string> | null
            requestedAt: DateTime.Utc
            expiresAt: DateTime.Utc
          }
          requestRows.set(args.id, {
            id: args.id,
            grantType: 'authorization_code',
            clientId: args.clientId,
            requestedScopes: args.requestedScopes,
            codeChallenge: args.codeChallenge,
            codeChallengeMethod: args.codeChallengeMethod,
            redirectUri: args.redirectUri,
            clientState: args.clientState,
            userCode: null,
            preApprovedScopes: args.preApprovedScopes,
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
          const args = event.args as {
            id: string
            grantedScopes: ReadonlyArray<string>
            patient: string | null
          }
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
          const args = event.args as { id: string }
          const existing = requestRows.get(args.id)
          if (existing !== undefined) {
            requestRows.set(args.id, { ...existing, status: 'denied' })
          }
          break
        }
        case 'v1.AuthorizationRequestExpired': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as { id: string }
          const existing = requestRows.get(args.id)
          if (existing !== undefined) {
            requestRows.set(args.id, { ...existing, status: 'expired' })
          }
          break
        }
        case 'v1.AuthorizationCodeIssued': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as AuthorizationCodeRow
          codeRows.set(args.code, args)
          break
        }
        case 'v1.AuthorizationCodeConsumed': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as { code: string }
          codeRows.delete(args.code)
          break
        }
        // Other events (e.g. GrantCreated, GrantUpdated, SigningKeyAdded) are no-ops in this mock.
        default:
          break
      }
    }
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    query,
    commit,
  } as unknown as typeof GatekeeperStore.Service
}

const createOAuthHandler = (
  store: typeof GatekeeperStore.Service
): ReturnType<typeof HttpApiBuilder.toWebHandler> => {
  const apiLive = GatekeeperApiLive.pipe(
    Layer.provide(GatekeeperStore.layerFrom(store)),
    Layer.provide(Origin.layerFromLiteral('http://localhost:8787')),
    Layer.provide(cryptoRandomCounter({ uuidPrefix: 'oauth' }))
  )

  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

test('authorize returns inline error HTML for unsupported code challenge method', async () => {
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
    })
  )

  try {
    const response = await handler(
      new Request(
        'http://localhost/oauth/authorize?code_challenge_method=plain&client_id=test-client&scope=patient/*.read&code_challenge=abc123&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&state=test-state'
      )
    )

    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).toContain('Unsupported code challenge method')
    expect(body).toContain('plain')
  } finally {
    await dispose()
  }
})

test('authorize auto-approves using matching redirect row from byClientIdAndRedirectUri', async () => {
  const grantedAt = DateTime.unsafeNow()
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
      clients: [
        makeClient({
          clientId: 'client-123',
          redirectUris: ['https://other.example/callback', 'https://app.example/callback'],
          allowedScopes: ['patient/*.read', 'launch'],
        }),
      ],
      grants: [
        {
          id: 'app-a',
          clientId: 'client-123',
          scopes: ['launch'],
          redirectUri: 'https://other.example/callback',
          grantedAt,
          lastUsedAt: null,
          patient: null,
        },
        {
          id: 'app-b',
          clientId: 'client-123',
          scopes: ['patient/*.read', 'launch'],
          redirectUri: 'https://app.example/callback',
          grantedAt,
          lastUsedAt: null,
          patient: 'patient-1',
        },
      ],
    })
  )

  try {
    const response = await handler(
      new Request(
        'http://localhost/oauth/authorize?code_challenge_method=S256&client_id=client-123&scope=patient/*.read%20launch&code_challenge=test-challenge&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&state=state-123'
      )
    )

    expect(response.status).toBe(302)
    const location = response.headers.get('location')
    expect(location).toBeTruthy()
    expect(location).toContain('https://app.example/callback?')
    expect(location).toContain('state=state-123')
    expect(location).toContain('code=')
  } finally {
    await dispose()
  }
})

test('authorize redirects to the polling page', async () => {
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
      clients: [makeClient()],
    })
  )

  try {
    const response = await handler(
      new Request(
        'http://localhost/oauth/authorize?code_challenge_method=S256&client_id=test-client&scope=patient/*.read&code_challenge=abc123&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&state=test-state'
      )
    )

    expect(response.status).toBe(302)
    const location = response.headers.get('location')
    expect(location).toBe('http://localhost:8787/gatekeeper/oauth-polling/oauth-0001')
  } finally {
    await dispose()
  }
})

test('token exchange rejects invalid content type before handler logic', async () => {
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
    })
  )

  try {
    const response = await handler(
      new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      })
    )

    expect(response.status).toBe(400)
  } finally {
    await dispose()
  }
})

test('token exchange succeeds with valid form payload', async () => {
  const codeVerifier = 'sample-verifier-123-padded-to-meet-rfc-7636-min-length'
  const codeChallenge = await Effect.runPromise(computeCodeChallenge(codeVerifier))

  const seededCode: AuthorizationCodeRow = {
    code: 'auth-code-1',
    requestId: 'req-1',
    clientId: 'client-1',
    redirectUri: 'https://app.example/callback',
    codeChallenge,
    grantedScopes: ['patient/*.read'],
    patient: 'patient-123',
    issuedAt: DateTime.unsafeNow(),
    expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '60 seconds'),
  }

  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
      clients: [
        makeClient({
          clientId: 'client-1',
          redirectUris: ['https://app.example/callback'],
          allowedScopes: ['patient/*.read'],
        }),
      ],
      authorizationCodes: [seededCode],
    })
  )

  try {
    const payload = new URLSearchParams({
      client_id: 'client-1',
      code: 'auth-code-1',
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: 'https://app.example/callback',
    })

    const response = await handler(
      new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: payload,
      })
    )

    expect(response.status).toBe(200)
    const bodyText = await response.text()
    expect(bodyText).toContain('"token_type":"Bearer"')
    expect(bodyText).toContain('"expires_in":3600')
    expect(bodyText).toContain('"scope":"patient/*.read"')
    expect(bodyText).toContain('"patient":"patient-123"')

    // Decode the freshly minted JWT and regression-guard every claim we
    // emit. Without these, dropping `iss` or flipping the payload shape
    // ships green.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const body = JSON.parse(bodyText) as { access_token: string }
    expect(typeof body.access_token).toBe('string')
    expect(body.access_token.length).toBeGreaterThan(0)
    const decoded = jose.decodeJwt(body.access_token)
    expect(decoded.iss).toBe('http://localhost:8787')
    expect(decoded.sub).toBe('client-1')
    expect(decoded.aud).toBe('http://localhost:8787/fhir-r4')
    expect(decoded['scope']).toBe('patient/*.read')
    expect(decoded['patient']).toBe('patient-123')
    expect(typeof decoded.iat).toBe('number')
    expect(typeof decoded.exp).toBe('number')
    // Single token shape: no `type` claim (the PIN/session split is gone).
    expect(decoded['type']).toBeUndefined()
  } finally {
    await dispose()
  }
})

test('authorize rejects an unknown client_id', async () => {
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
    })
  )

  try {
    const response = await handler(
      new Request(
        'http://localhost/oauth/authorize?code_challenge_method=S256&client_id=unknown-client&scope=patient/*.read&code_challenge=abc&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&state=s'
      )
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Unknown client')
  } finally {
    await dispose()
  }
})

test('authorize rejects a disabled client', async () => {
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
      clients: [makeClient({ disabledAt: DateTime.unsafeNow() })],
    })
  )

  try {
    const response = await handler(
      new Request(
        'http://localhost/oauth/authorize?code_challenge_method=S256&client_id=test-client&scope=patient/*.read&code_challenge=abc&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&state=s'
      )
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Disabled client')
  } finally {
    await dispose()
  }
})

test('authorize rejects redirect_uri not in client allowlist', async () => {
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
      clients: [makeClient({ redirectUris: ['https://allowed.example/cb'] })],
    })
  )

  try {
    const response = await handler(
      new Request(
        'http://localhost/oauth/authorize?code_challenge_method=S256&client_id=test-client&scope=patient/*.read&code_challenge=abc&redirect_uri=https%3A%2F%2Fmalicious.example%2Fcb&state=s'
      )
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Redirect URI not allowed')
  } finally {
    await dispose()
  }
})

test('authorize rejects requested scope not in client allowedScopes', async () => {
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
      clients: [makeClient({ allowedScopes: ['launch'] })],
    })
  )

  try {
    const response = await handler(
      new Request(
        'http://localhost/oauth/authorize?code_challenge_method=S256&client_id=test-client&scope=patient/*.read%20launch&code_challenge=abc&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&state=s'
      )
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Scope not allowed')
  } finally {
    await dispose()
  }
})

test('token exchange rejects unknown client_id with 401', async () => {
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
    })
  )

  try {
    const payload = new URLSearchParams({
      client_id: 'unknown-client',
      code: 'auth-code-1',
      code_verifier: 'sample-verifier-123-padded-to-meet-rfc-7636-min-length',
      grant_type: 'authorization_code',
      redirect_uri: 'https://app.example/callback',
    })
    const response = await handler(
      new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: payload,
      })
    )
    expect(response.status).toBe(401)
  } finally {
    await dispose()
  }
})

test('token exchange rejects code_verifier shorter than 43 chars', async () => {
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
      clients: [makeClient({ clientId: 'client-1' })],
    })
  )

  try {
    const payload = new URLSearchParams({
      client_id: 'client-1',
      code: 'auth-code-1',
      code_verifier: 'too-short',
      grant_type: 'authorization_code',
      redirect_uri: 'https://app.example/callback',
    })
    const response = await handler(
      new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: payload,
      })
    )
    expect(response.status).toBe(400)
  } finally {
    await dispose()
  }
})

const VALID_VERIFIER = 'sample-verifier-123-padded-to-meet-rfc-7636-min-length'

const seededClient = (overrides: Partial<ClientRow> = {}): ClientRow =>
  makeClient({
    clientId: 'client-1',
    redirectUris: ['https://app.example/callback'],
    allowedScopes: ['patient/*.read'],
    ...overrides,
  })

const formBody = (overrides: Record<string, string> = {}): URLSearchParams =>
  new URLSearchParams({
    client_id: 'client-1',
    code: 'auth-code-1',
    code_verifier: VALID_VERIFIER,
    grant_type: 'authorization_code',
    redirect_uri: 'https://app.example/callback',
    ...overrides,
  })

test('token exchange returns 400 invalid_request when code is unknown', async () => {
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
      clients: [seededClient()],
      // No authorization codes seeded — `byCode$` returns null.
    })
  )
  try {
    const response = await handler(
      new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody(),
      })
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('"error":"invalid_request"')
  } finally {
    await dispose()
  }
})

test('token exchange returns 400 when code clientId does not match form client_id', async () => {
  const codeChallenge = await Effect.runPromise(computeCodeChallenge(VALID_VERIFIER))
  const seededCode: AuthorizationCodeRow = {
    code: 'auth-code-1',
    requestId: 'req-1',
    clientId: 'OTHER-CLIENT',
    redirectUri: 'https://app.example/callback',
    codeChallenge,
    grantedScopes: ['patient/*.read'],
    patient: null,
    issuedAt: DateTime.unsafeNow(),
    expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '60 seconds'),
  }
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
      clients: [seededClient()],
      authorizationCodes: [seededCode],
    })
  )
  try {
    const response = await handler(
      new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody(),
      })
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Invalid client_id parameter')
  } finally {
    await dispose()
  }
})

test('token exchange returns 400 when redirect_uri does not match the issued code', async () => {
  const codeChallenge = await Effect.runPromise(computeCodeChallenge(VALID_VERIFIER))
  const seededCode: AuthorizationCodeRow = {
    code: 'auth-code-1',
    requestId: 'req-1',
    clientId: 'client-1',
    redirectUri: 'https://other.example/callback',
    codeChallenge,
    grantedScopes: ['patient/*.read'],
    patient: null,
    issuedAt: DateTime.unsafeNow(),
    expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '60 seconds'),
  }
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
      clients: [seededClient()],
      authorizationCodes: [seededCode],
    })
  )
  try {
    const response = await handler(
      new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody(),
      })
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Invalid redirect_uri parameter')
  } finally {
    await dispose()
  }
})

test('token exchange returns 400 when the code has expired', async () => {
  const codeChallenge = await Effect.runPromise(computeCodeChallenge(VALID_VERIFIER))
  const seededCode: AuthorizationCodeRow = {
    code: 'auth-code-1',
    requestId: 'req-1',
    clientId: 'client-1',
    redirectUri: 'https://app.example/callback',
    codeChallenge,
    grantedScopes: ['patient/*.read'],
    patient: null,
    issuedAt: DateTime.subtract(DateTime.unsafeNow(), { hours: 1 }),
    expiresAt: DateTime.subtract(DateTime.unsafeNow(), { minutes: 5 }),
  }
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
      clients: [seededClient()],
      authorizationCodes: [seededCode],
    })
  )
  try {
    const response = await handler(
      new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody(),
      })
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Code has expired')
  } finally {
    await dispose()
  }
})

test('token exchange returns 400 when code_verifier does not match the stored challenge', async () => {
  const realCodeChallenge = await Effect.runPromise(computeCodeChallenge(VALID_VERIFIER))
  const seededCode: AuthorizationCodeRow = {
    code: 'auth-code-1',
    requestId: 'req-1',
    clientId: 'client-1',
    redirectUri: 'https://app.example/callback',
    codeChallenge: realCodeChallenge,
    grantedScopes: ['patient/*.read'],
    patient: null,
    issuedAt: DateTime.unsafeNow(),
    expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '60 seconds'),
  }
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [sharedSigningKey],
      clients: [seededClient()],
      authorizationCodes: [seededCode],
    })
  )
  try {
    const response = await handler(
      new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        // Submit a *different* verifier of valid length — its hash won't
        // match the seeded challenge.
        body: formBody({
          code_verifier: 'a-different-verifier-of-the-right-length-12345678901234567890',
        }),
      })
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Invalid code_verifier parameter')
  } finally {
    await dispose()
  }
})

test('token exchange returns 500 server_error when no signing keys are available', async () => {
  const codeChallenge = await Effect.runPromise(computeCodeChallenge(VALID_VERIFIER))
  const seededCode: AuthorizationCodeRow = {
    code: 'auth-code-1',
    requestId: 'req-1',
    clientId: 'client-1',
    redirectUri: 'https://app.example/callback',
    codeChallenge,
    grantedScopes: ['patient/*.read'],
    patient: null,
    issuedAt: DateTime.unsafeNow(),
    expiresAt: DateTime.addDuration(DateTime.unsafeNow(), '60 seconds'),
  }
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      signingKeys: [], // empty signing-keys table
      clients: [seededClient()],
      authorizationCodes: [seededCode],
    })
  )
  try {
    const response = await handler(
      new Request('http://localhost/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody(),
      })
    )
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('"error":"server_error"')
  } finally {
    await dispose()
  }
})
