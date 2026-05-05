import { HttpApiBuilder, HttpServer, HttpServerResponse } from '@effect/platform'
import { DateTime, Effect, Layer } from 'effect'
import { Origin } from 'kitchen-sink'
import { beforeEach, expect, test } from 'vite-plus/test'
import { type AuthRendererInterface, AuthRenderer } from '../src/contexts/AuthRenderer.ts'
import { getAuthStateSingleton } from '../src/contexts/AuthState.ts'
import { type AuthStore, makeAuthStoreLayer } from '../src/contexts/AuthStore.ts'
import { OAuthDisplayDefaultInteractive } from '../src/contexts/OAuthDisplayDefault.ts'
import { AuthApiLive } from '../src/http-api-implementation/index.ts'
import { computeCodeChallenge } from '../src/internal/pkce.ts'
import { JsonWebKeys } from '../src/livestore/index.ts'

const renderer: AuthRendererInterface = {
  oauthPollingPage: ({ clientId, statusUrl }) =>
    HttpServerResponse.html(`<html><body>client:${clientId};status:${statusUrl}</body></html>`),
  oauthError: ({ kind, method }) =>
    HttpServerResponse.html(`<html><body>error:${kind}:${method ?? ''}</body></html>`),
  pinPage: () => HttpServerResponse.html('<html><body>pin</body></html>'),
  pinError: () => HttpServerResponse.html('<html><body>pin-error</body></html>'),
}

type MockStoreOptions = {
  jwks?: ReadonlyArray<{
    signJwt: (payload: Record<string, unknown>) => Promise<string>
    verifyJwt: (token: string) => Promise<{ payload: Record<string, unknown> }>
  }>
  approvedApps?: ReadonlyArray<{
    id: string
    clientId: string
    type: string
    scopes: ReadonlyArray<string>
    redirectUri: string | null
    approvedAt: DateTime.Utc
    lastAccessedAt: DateTime.Utc | null
    label: string
    patient: string | null
  }>
}

const makeStore = ({ jwks = [], approvedApps = [] }: MockStoreOptions): typeof AuthStore.Service =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  ({
    query: <TResult>(query: unknown): TResult => {
      if (query === JsonWebKeys.queries.allJwks$) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- query result type is selected by callsite query object
        return jwks as TResult
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- query result type is selected by callsite query object
      return approvedApps as TResult
    },
    commit: () => undefined,
  }) as unknown as typeof AuthStore.Service

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

beforeEach(() => {
  const state = getAuthStateSingleton()
  state.authMaps.clear()
  state.pendingAuths.clear()
  state.pinAuths.clear()
})

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
      approvedApps: [
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
  const state = getAuthStateSingleton()
  const codeVerifier = 'sample-verifier-123'
  const codeChallenge = await Effect.runPromise(computeCodeChallenge(codeVerifier))

  state.authMaps.set('auth-code-1', {
    code: 'auth-code-1',
    code_challenge: codeChallenge,
    client_id: 'client-1',
    scope: 'patient/*.read',
    redirect_uri: 'https://app.example/callback',
    exp: DateTime.addDuration(DateTime.unsafeNow(), '5 minutes'),
    patient: 'patient-123',
  })

  const { handler, dispose } = createOAuthHandler(
    makeStore({
      jwks: [
        {
          signJwt: async () => 'signed.jwt.token',
          verifyJwt: async () => ({ payload: {} }),
        },
      ],
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
