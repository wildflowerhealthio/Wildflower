import { HttpApiBuilder, HttpServer, HttpServerResponse } from '@effect/platform'
import { DateTime, Effect, Layer } from 'effect'
import { Origin } from 'kitchen-sink'
import { expect, test } from 'vite-plus/test'
import { type AuthRendererInterface, AuthRenderer } from '../src/contexts/AuthRenderer.ts'
import { type AuthStore, makeAuthStoreLayer } from '../src/contexts/AuthStore.ts'
import { OAuthDisplayDefaultInteractive } from '../src/contexts/OAuthDisplayDefault.ts'
import { AuthApiLive } from '../src/http-api-implementation/index.ts'
import { computeCodeChallenge } from '../src/internal/pkce.ts'
import {
  AuthCodes,
  type AuthCodeRow,
  Clients,
  JsonWebKeys,
  PinAuths,
  type PinAuthRow,
} from '../src/livestore/index.ts'

const renderer: AuthRendererInterface = {
  oauthPollingPage: ({ clientId, statusUrl }) =>
    HttpServerResponse.html(`<html><body>client:${clientId};status:${statusUrl}</body></html>`),
  oauthError: ({ kind, method }) =>
    HttpServerResponse.html(`<html><body>error:${kind}:${method ?? ''}</body></html>`),
  pinPage: () => HttpServerResponse.html('<html><body>pin</body></html>'),
  pinError: () => HttpServerResponse.html('<html><body>pin-error</body></html>'),
}

type MockClient = {
  id: string
  clientId: string
  type: string
  scopes: ReadonlyArray<string>
  redirectUri: string | null
  approvedAt: DateTime.Utc
  lastAccessedAt: DateTime.Utc | null
  label: string
  patient: string | null
}

type MockStoreOptions = {
  jwks?: ReadonlyArray<{
    signJwt: (payload: Record<string, unknown>) => Promise<string>
    verifyJwt: (token: string) => Promise<{ payload: Record<string, unknown> }>
  }>
  clients?: ReadonlyArray<MockClient>
  authCodes?: ReadonlyArray<AuthCodeRow>
  pinAuths?: ReadonlyArray<PinAuthRow>
}

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
  authCodes = [],
  pinAuths = [],
}: MockStoreOptions): typeof AuthStore.Service => {
  const authCodeRows = new Map<string, AuthCodeRow>()
  for (const row of authCodes) {
    authCodeRows.set(row.code, row)
  }
  const pinAuthRows = new Map<string, PinAuthRow>()
  for (const row of pinAuths) {
    pinAuthRows.set(row.id, row)
  }
  const clientRows: MockClient[] = [...clients]

  const query = (q: unknown): unknown => {
    if (q === JsonWebKeys.queries.allJwks$) {
      return jwks
    }

    const label = queryLabel(q)
    const hash = queryHash(q)

    if (label === 'authCodeByCode' && hash !== undefined) {
      for (const code of authCodeRows.keys()) {
        if (AuthCodes.queries.byCode$(code).hash === hash) {
          return authCodeRows.get(code) ?? null
        }
      }
      return null
    }

    if (label === 'pinAuthById' && hash !== undefined) {
      for (const id of pinAuthRows.keys()) {
        if (PinAuths.queries.byId$(id).hash === hash) {
          return pinAuthRows.get(id) ?? null
        }
      }
      return null
    }

    if (label === 'clientByClientId' && hash !== undefined) {
      const seenClientIds = new Set(clientRows.map((c) => c.clientId))
      for (const clientId of seenClientIds) {
        if (Clients.queries.byClientId$(clientId).hash === hash) {
          return clientRows.filter((c) => c.clientId === clientId)
        }
      }
      return []
    }

    if (label === 'authCodes') {
      return [...authCodeRows.values()]
    }
    if (label === 'pinAuths') {
      return [...pinAuthRows.values()]
    }
    if (label === 'authCodesExpired' || label === 'pinAuthsExpired') {
      return []
    }

    return clientRows
  }

  const commit = (...events: ReadonlyArray<CommittedEvent>): void => {
    for (const event of events) {
      switch (event.name) {
        case 'v1.AuthCodeCreated': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as {
            code: string
            clientId: string
            scope: string
            codeChallenge: string
            redirectUri: string
            state: string
            exp: DateTime.Utc
            preApprovedScopes: ReadonlyArray<string> | null
          }
          authCodeRows.set(args.code, {
            code: args.code,
            clientId: args.clientId,
            scope: args.scope,
            codeChallenge: args.codeChallenge,
            redirectUri: args.redirectUri,
            state: args.state,
            exp: args.exp,
            status: 'pending',
            approvedScopes: null,
            patient: null,
            preApprovedScopes: args.preApprovedScopes,
          })
          break
        }
        case 'v1.AuthCodeApproved': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as {
            code: string
            approvedScopes: ReadonlyArray<string>
            patient: string | null
          }
          const existing = authCodeRows.get(args.code)
          if (existing !== undefined) {
            authCodeRows.set(args.code, {
              ...existing,
              status: 'approved',
              approvedScopes: args.approvedScopes,
              patient: args.patient,
              scope: args.approvedScopes.join(' '),
            })
          }
          break
        }
        case 'v1.AuthCodeDeleted': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as { code: string }
          authCodeRows.delete(args.code)
          break
        }
        case 'v1.PinAuthCreated': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as {
            id: string
            pin: string
            returnTo: string
            exp: DateTime.Utc
          }
          pinAuthRows.set(args.id, {
            id: args.id,
            pin: args.pin,
            returnTo: args.returnTo,
            exp: args.exp,
            status: 'pending',
            duration: null,
            attempts: 0,
          })
          break
        }
        case 'v1.PinAuthApproved': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as { id: string; duration: PinAuthRow['duration'] }
          const existing = pinAuthRows.get(args.id)
          if (existing !== undefined) {
            pinAuthRows.set(args.id, {
              ...existing,
              status: 'approved',
              duration: args.duration,
            })
          }
          break
        }
        case 'v1.PinAuthAttemptFailed': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as { id: string; attempts: number }
          const existing = pinAuthRows.get(args.id)
          if (existing !== undefined) {
            pinAuthRows.set(args.id, { ...existing, attempts: args.attempts })
          }
          break
        }
        case 'v1.PinAuthDeleted': {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args = event.args as { id: string }
          pinAuthRows.delete(args.id)
          break
        }
        // Other events (e.g. ClientApproved, JwkAdded) are no-ops in this mock.
        default:
          break
      }
    }
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    query,
    commit,
  } as unknown as typeof AuthStore.Service
}

const createOAuthHandler = (
  store: typeof AuthStore.Service
): ReturnType<typeof HttpApiBuilder.toWebHandler> => {
  const apiLive = AuthApiLive.pipe(
    Layer.provide(makeAuthStoreLayer(store)),
    Layer.provide(Layer.succeed(AuthRenderer, renderer)),
    Layer.provide(Layer.succeed(Origin, 'http://localhost:8787')),
    Layer.provide(OAuthDisplayDefaultInteractive)
  )

  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

test('authorize returns renderer error for unsupported code challenge method', async () => {
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
        'http://localhost/auth/authorize?code_challenge_method=plain&client_id=test-client&scope=patient/*.read&code_challenge=abc123&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&state=test-state'
      )
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('error:unsupported_code_challenge:plain')
  } finally {
    await dispose()
  }
})

test('authorize auto-approves using matching redirect row from byClientId results', async () => {
  const approvedAt = DateTime.unsafeNow()
  const { handler, dispose } = createOAuthHandler(
    makeStore({
      jwks: [
        {
          signJwt: async () => 'unused',
          verifyJwt: async () => ({ payload: {} }),
        },
      ],
      clients: [
        {
          id: 'app-a',
          clientId: 'client-123',
          type: 'oauth',
          scopes: ['launch'],
          redirectUri: 'https://other.example/callback',
          approvedAt,
          lastAccessedAt: null,
          label: 'Other Redirect',
          patient: null,
        },
        {
          id: 'app-b',
          clientId: 'client-123',
          type: 'oauth',
          scopes: ['patient/*.read', 'launch'],
          redirectUri: 'https://app.example/callback',
          approvedAt,
          lastAccessedAt: null,
          label: 'Matching Redirect',
          patient: 'patient-1',
        },
      ],
    })
  )

  try {
    const response = await handler(
      new Request(
        'http://localhost/auth/authorize?code_challenge_method=S256&client_id=client-123&scope=patient/*.read%20launch&code_challenge=test-challenge&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&state=state-123'
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

test('authorize redirects to authorization UI by default', async () => {
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
        'http://localhost/auth/authorize?code_challenge_method=S256&client_id=test-client&scope=patient/*.read&code_challenge=abc123&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&state=test-state'
      )
    )

    expect(response.status).toBe(302)
    const location = response.headers.get('location')
    expect(location).toMatch(/\/auth\/ui\/authorization_request\/[0-9a-f-]+$/)
  } finally {
    await dispose()
  }
})

test('authorize renders polling page when display=polling', async () => {
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
        'http://localhost/auth/authorize?code_challenge_method=S256&client_id=test-client&scope=patient/*.read&code_challenge=abc123&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&state=test-state&display=polling'
      )
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('client:test-client')
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
      new Request('http://localhost/auth/token', {
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
  const codeVerifier = 'sample-verifier-123'
  const codeChallenge = await Effect.runPromise(computeCodeChallenge(codeVerifier))

  const seededAuthCode: AuthCodeRow = {
    code: 'auth-code-1',
    codeChallenge,
    clientId: 'client-1',
    scope: 'patient/*.read',
    redirectUri: 'https://app.example/callback',
    state: 'state-1',
    exp: DateTime.addDuration(DateTime.unsafeNow(), '5 minutes'),
    status: 'approved',
    approvedScopes: ['patient/*.read'],
    patient: 'patient-123',
    preApprovedScopes: null,
  }

  const { handler, dispose } = createOAuthHandler(
    makeStore({
      jwks: [
        {
          signJwt: async () => 'signed.jwt.token',
          verifyJwt: async () => ({ payload: {} }),
        },
      ],
      authCodes: [seededAuthCode],
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
      new Request('http://localhost/auth/token', {
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
  } finally {
    await dispose()
  }
})
