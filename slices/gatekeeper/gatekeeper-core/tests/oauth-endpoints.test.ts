import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { DateTime, Effect, Layer } from 'effect'
import { Origin } from 'kitchen-sink'
import { expect, test } from 'vite-plus/test'
import { type GatekeeperStore, makeGatekeeperStoreLayer } from '../src/contexts/gatekeeper-store.ts'
import { GatekeeperApi } from '../src/http-api-definition/index.ts'
import {
  GatekeeperApiLive,
  RequireAuthMiddlewareLive,
} from '../src/http-api-implementation/index.ts'
import { computeCodeChallenge } from '../src/internal/pkce.ts'
import {
  AuthorizationCodes,
  type AuthorizationCodeRow,
  AuthorizationRequests,
  type AuthorizationRequestRow,
  Clients,
  type ClientRow,
  Grants,
  SigningKeys,
} from '../src/livestore/index.ts'

// Tests don't exercise page endpoints; supply a stub pages layer so
// `HttpApiBuilder.toWebHandler` finds a handler for the gatekeeper-pages
// group (which has no core handler — by design).
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
  jwks?: ReadonlyArray<{
    signJwt: (payload: Record<string, unknown>) => Promise<string>
    verifyJwt: (token: string) => Promise<{ payload: Record<string, unknown> }>
  }>
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

// Each LiveQueryDef carries a stable `hash` derived from its query string and
// bind values. We reconstruct the matching def for each known row and compare
// hashes to figure out what the production code is asking for.
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
  jwks = [],
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
    if (q === SigningKeys.queries.all$) {
      return jwks
    }

    const label = queryLabel(q)
    const hash = queryHash(q)

    if (label === 'authorizationRequestById' && hash !== undefined) {
      for (const id of requestRows.keys()) {
        if (AuthorizationRequests.queries.byId$(id).hash === hash) {
          return requestRows.get(id) ?? null
        }
      }
      return null
    }

    if (label === 'authorizationCodeByCode' && hash !== undefined) {
      for (const code of codeRows.keys()) {
        if (AuthorizationCodes.queries.byCode$(code).hash === hash) {
          return codeRows.get(code) ?? null
        }
      }
      return null
    }

    if (label === 'authorizationCodeByRequestId' && hash !== undefined) {
      for (const requestId of new Set([...codeRows.values()].map((r) => r.requestId))) {
        if (AuthorizationCodes.queries.byRequestId$(requestId).hash === hash) {
          return [...codeRows.values()].find((r) => r.requestId === requestId) ?? null
        }
      }
      return null
    }

    if (label === 'grantsByClientId' && hash !== undefined) {
      const seenClientIds = new Set(grantRows.map((g) => g.clientId))
      for (const clientId of seenClientIds) {
        if (Grants.queries.byClientId$(clientId).hash === hash) {
          return grantRows.filter((g) => g.clientId === clientId)
        }
      }
      return []
    }

    if (label === 'grantByClientIdAndRedirectUri' && hash !== undefined) {
      for (const g of grantRows) {
        if (Grants.queries.byClientIdAndRedirectUri$(g.clientId, g.redirectUri).hash === hash) {
          return g
        }
      }
      return null
    }

    if (label === 'clientById' && hash !== undefined) {
      for (const clientId of clientRows.keys()) {
        if (Clients.queries.byId$(clientId).hash === hash) {
          return clientRows.get(clientId) ?? null
        }
      }
      return null
    }

    if (label === 'activeSigningKey') {
      return jwks[0] ?? null
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
            codeChallengeMethod: string
            redirectUri: string
            clientState: string
            preApprovedScopes: ReadonlyArray<string> | null
            requestedAt: DateTime.Utc
            expiresAt: DateTime.Utc
          }
          requestRows.set(args.id, {
            id: args.id,
            flow: 'authorization_code',
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
    Layer.provide(StubGatekeeperPagesLive),
    Layer.provide(makeGatekeeperStoreLayer(store)),
    Layer.provide(Layer.succeed(Origin, 'http://localhost:8787'))
  )

  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

test('authorize returns inline error HTML for unsupported code challenge method', async () => {
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      jwks: [
        {
          signJwt: async () => 'unused',
          verifyJwt: async () => ({ payload: {} }),
        },
      ],
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
      jwks: [
        {
          signJwt: async () => 'unused',
          verifyJwt: async () => ({ payload: {} }),
        },
      ],
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
      jwks: [
        {
          signJwt: async () => 'unused',
          verifyJwt: async () => ({ payload: {} }),
        },
      ],
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
    expect(location).toMatch(/\/oauth\/authorize\/[0-9a-f-]+\/ui$/)
  } finally {
    await dispose()
  }
})

test('token exchange rejects invalid content type before handler logic', async () => {
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      jwks: [
        {
          signJwt: async () => 'unused',
          verifyJwt: async () => ({ payload: {} }),
        },
      ],
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

  let capturedJwtPayload: Record<string, unknown> | undefined
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      jwks: [
        {
          signJwt: async (payload: Record<string, unknown>) => {
            capturedJwtPayload = payload
            return 'signed.jwt.token'
          },
          verifyJwt: async () => ({ payload: {} }),
        },
      ],
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
    expect(bodyText).toContain('"access_token":"signed.jwt.token"')
    expect(bodyText).toContain('"token_type":"Bearer"')
    expect(bodyText).toContain('"expires_in":3600')
    expect(bodyText).toContain('"scope":"patient/*.read"')
    expect(bodyText).toContain('"patient":"patient-123"')

    // The signed JWT payload itself: regression-guards every claim we
    // mint into a token. Without these, dropping `iss` or flipping the
    // payload shape ships green.
    expect(capturedJwtPayload).toBeDefined()
    expect(capturedJwtPayload?.['iss']).toBe('http://localhost:8787')
    expect(capturedJwtPayload?.['sub']).toBe('client-1')
    expect(capturedJwtPayload?.['aud']).toBe('http://localhost:8787/fhir')
    expect(capturedJwtPayload?.['scope']).toBe('patient/*.read')
    expect(capturedJwtPayload?.['patient']).toBe('patient-123')
    expect(typeof capturedJwtPayload?.['iat']).toBe('number')
    expect(typeof capturedJwtPayload?.['exp']).toBe('number')
    // Single token shape: no `type` claim (the PIN/session split is gone).
    expect(capturedJwtPayload?.['type']).toBeUndefined()
  } finally {
    await dispose()
  }
})

test('authorize rejects an unknown client_id', async () => {
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      jwks: [{ signJwt: async () => 'unused', verifyJwt: async () => ({ payload: {} }) }],
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
      jwks: [{ signJwt: async () => 'unused', verifyJwt: async () => ({ payload: {} }) }],
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
      jwks: [{ signJwt: async () => 'unused', verifyJwt: async () => ({ payload: {} }) }],
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
      jwks: [{ signJwt: async () => 'unused', verifyJwt: async () => ({ payload: {} }) }],
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
      jwks: [{ signJwt: async () => 'signed', verifyJwt: async () => ({ payload: {} }) }],
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
      jwks: [{ signJwt: async () => 'signed', verifyJwt: async () => ({ payload: {} }) }],
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
      jwks: [{ signJwt: async () => 'signed', verifyJwt: async () => ({ payload: {} }) }],
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
      jwks: [{ signJwt: async () => 'signed', verifyJwt: async () => ({ payload: {} }) }],
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
      jwks: [{ signJwt: async () => 'signed', verifyJwt: async () => ({ payload: {} }) }],
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
      jwks: [{ signJwt: async () => 'signed', verifyJwt: async () => ({ payload: {} }) }],
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
      jwks: [{ signJwt: async () => 'signed', verifyJwt: async () => ({ payload: {} }) }],
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
      jwks: [], // empty signing-keys table
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
