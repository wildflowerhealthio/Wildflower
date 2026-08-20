import { Effect, Either, Match, Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  parsePendingAuthorization,
  PENDING_AUTHORIZATION_KEY,
  serializePendingAuthorization,
  type PendingAuthorization,
} from './authorization-flow.ts'
import { codeChallengeS256 } from './pkce.ts'
import {
  beginSignIn,
  completeSignIn,
  type PendingStore,
  type SignInEnvironment,
} from './sign-in.ts'
import { REGISTERED_REDIRECT_URI } from './smart-client.ts'

const SERVER = 'https://ruth.wildflowerhealth.io'

describe('beginSignIn', () => {
  it('builds an authorization URL from the endpoints the server advertised', async () => {
    // Arrange
    const store = memoryStore()
    const environment = testEnvironment({ store, fetch: discoveryOnly() })

    // Act
    const result = await runToEither(beginSignIn(SERVER, environment))

    // Assert
    if (Either.isLeft(result)) throw new Error(result.left.reason)
    const url = new URL(result.right)
    expect(url.origin + url.pathname).toBe(`${SERVER}/oauth/authorize`)
    expect(url.searchParams.get('client_id')).toBe('wildflower-server-docs')
    expect(url.searchParams.get('redirect_uri')).toBe(REGISTERED_REDIRECT_URI)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('stashes the verifier that matches the challenge it sent', async () => {
    // The two halves of PKCE are minted here and redeemed a page load later, so
    // this is the property that makes the round trip work at all.
    // Arrange
    const store = memoryStore()
    const environment = testEnvironment({ store, fetch: discoveryOnly() })

    // Act
    const result = await runToEither(beginSignIn(SERVER, environment))

    // Assert
    if (Either.isLeft(result)) throw new Error(result.left.reason)
    const stashed = parsePendingAuthorization(store.getItem(PENDING_AUTHORIZATION_KEY))
    if (Option.isNone(stashed)) throw new Error('nothing was stashed')
    const pending = stashed.value
    const url = new URL(result.right)
    expect(url.searchParams.get('code_challenge')).toBe(
      await Effect.runPromise(codeChallengeS256(pending.codeVerifier, globalThis.crypto.subtle))
    )
    expect(url.searchParams.get('state')).toBe(pending.state)
    expect(pending.tokenEndpoint).toBe(`${SERVER}/oauth/token`)
    expect(pending.serverUrl).toBe(SERVER)
  })

  it('mints a fresh state and verifier for every sign-in', async () => {
    // Arrange
    const first = memoryStore()
    const second = memoryStore()

    // Act
    await runToEither(
      beginSignIn(SERVER, testEnvironment({ store: first, fetch: discoveryOnly() }))
    )
    await runToEither(
      beginSignIn(SERVER, testEnvironment({ store: second, fetch: discoveryOnly() }))
    )

    // Assert
    expect(first.getItem(PENDING_AUTHORIZATION_KEY)).not.toBe(
      second.getItem(PENDING_AUTHORIZATION_KEY)
    )
  })

  it('stashes nothing when the target cannot be discovered', async () => {
    // Arrange
    const store = memoryStore()
    const environment = testEnvironment({
      store,
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    })

    // Act
    const result = await runToEither(beginSignIn(SERVER, environment))

    // Assert
    if (Either.isRight(result)) throw new Error('expected discovery to fail the sign-in')
    expect(result.left._tag).toBe('DiscoveryFailed')
    expect(store.getItem(PENDING_AUTHORIZATION_KEY)).toBeNull()
  })

  it('reports a browser whose session storage refuses the record', async () => {
    // Arrange — Safari in private mode throws on `setItem`.
    const store: PendingStore = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError')
      },
      removeItem: () => {},
    }

    // Act
    const result = await runToEither(
      beginSignIn(SERVER, testEnvironment({ store, fetch: discoveryOnly() }))
    )

    // Assert
    if (Either.isRight(result)) throw new Error('expected the blocked storage to fail sign-in')
    expect(result.left._tag).toBe('PendingRequestUnusable')
    expect(result.left.reason).toContain('session storage')
  })
})

describe('completeSignIn', () => {
  it('leaves an ordinary page load alone', async () => {
    // Arrange
    const store = memoryStore()
    store.setItem(PENDING_AUTHORIZATION_KEY, serializePendingAuthorization(stashedRequest()))

    // Act
    const result = await runToEither(
      completeSignIn(
        '?server=https%3A%2F%2Fx.test',
        testEnvironment({ store, fetch: refusingFetch })
      )
    )

    // Assert
    expect(result).toEqual(Either.right(Option.none()))
    expect(store.getItem(PENDING_AUTHORIZATION_KEY)).not.toBeNull()
  })

  it('redeems the code and returns the granted session', async () => {
    // Arrange
    const store = memoryStore()
    const pending = stashedRequest()
    store.setItem(PENDING_AUTHORIZATION_KEY, serializePendingAuthorization(pending))
    const bodies: string[] = []
    const fetchStub: typeof globalThis.fetch = (_input, init) => {
      bodies.push(typeof init?.body === 'string' ? init.body : '')
      return Promise.resolve(
        jsonResponse({
          access_token: 'header.payload.signature',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid system/*.cruds',
        })
      )
    }

    // Act
    const result = await runToEither(
      completeSignIn(
        `?code=the-code&state=${pending.state}`,
        testEnvironment({ store, fetch: fetchStub })
      )
    )

    // Assert
    expect(result).toEqual(
      Either.right(
        Option.some({
          accessToken: 'header.payload.signature',
          scope: 'openid system/*.cruds',
          serverUrl: SERVER,
          expiresInSeconds: 3600,
        })
      )
    )
    const sent = new URLSearchParams(bodies[0])
    expect(sent.get('code_verifier')).toBe(pending.codeVerifier)
    expect(sent.get('redirect_uri')).toBe(REGISTERED_REDIRECT_URI)
  })

  it('never writes the access token to storage', async () => {
    // The console is a public page and the token can be admin-capable, so it
    // exists only in the caller's memory.
    await fc.assert(
      // JWT-shaped tokens: what a gatekeeper issues, and free of the JSON
      // punctuation that would make the substring check trivially true.
      fc.asyncProperty(
        fc.uuid().map((id) => `header.${id}.signature`),
        async (accessToken) => {
          // Arrange
          const store = memoryStore()
          const pending = stashedRequest()
          store.setItem(PENDING_AUTHORIZATION_KEY, serializePendingAuthorization(pending))
          const fetchStub: typeof globalThis.fetch = () =>
            Promise.resolve(jsonResponse({ access_token: accessToken, token_type: 'Bearer' }))

          // Act
          await runToEither(
            completeSignIn(
              `?code=the-code&state=${pending.state}`,
              testEnvironment({ store, fetch: fetchStub })
            )
          )

          // Assert
          expect(store.contents()).not.toContain(accessToken)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('consumes the pending record whatever the outcome', async () => {
    // A record left behind would make a later stray `?code=` look legitimate,
    // so a discarded flow must clear it just as a redeemed one does.
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (succeeds) => {
        // Arrange
        const store = memoryStore()
        const pending = stashedRequest()
        store.setItem(PENDING_AUTHORIZATION_KEY, serializePendingAuthorization(pending))
        const fetchStub: typeof globalThis.fetch = () =>
          Promise.resolve(
            jsonResponse(
              succeeds
                ? { access_token: 'a-token', token_type: 'Bearer' }
                : { error: 'invalid_grant' }
            )
          )

        // Act
        await runToEither(
          completeSignIn(
            `?code=the-code&state=${pending.state}`,
            testEnvironment({ store, fetch: fetchStub })
          )
        )

        // Assert
        expect(store.getItem(PENDING_AUTHORIZATION_KEY)).toBeNull()
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('clears the pending record when the server refuses the authorization', async () => {
    // Arrange
    const store = memoryStore()
    store.setItem(PENDING_AUTHORIZATION_KEY, serializePendingAuthorization(stashedRequest()))

    // Act
    const result = await runToEither(
      completeSignIn(
        '?error=access_denied&state=a-stashed-state',
        testEnvironment({ store, fetch: refusingFetch })
      )
    )

    // Assert
    expect(Either.isLeft(result)).toBe(true)
    expect(store.getItem(PENDING_AUTHORIZATION_KEY)).toBeNull()
  })

  it('never redeems a code whose state does not match the stashed one', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((state) => state !== stashedRequest().state),
        async (state) => {
          // Arrange
          const store = memoryStore()
          store.setItem(PENDING_AUTHORIZATION_KEY, serializePendingAuthorization(stashedRequest()))
          const requests: string[] = []
          const fetchStub: typeof globalThis.fetch = (input) => {
            requests.push(requestUrl(input))
            return Promise.resolve(jsonResponse({ access_token: 'a-token', token_type: 'Bearer' }))
          }

          // Act
          const result = await runToEither(
            completeSignIn(
              `?code=the-code&state=${encodeURIComponent(state)}`,
              testEnvironment({ store, fetch: fetchStub })
            )
          )

          // Assert — the code is never carried to the token endpoint at all.
          expect(requests).toEqual([])
          if (Either.isRight(result)) throw new Error('expected the state mismatch to fail')
          expect(result.left._tag).toBe('AuthorizationRejected')
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('reports a token endpoint that rejects the grant', async () => {
    // Arrange
    const store = memoryStore()
    const pending = stashedRequest()
    store.setItem(PENDING_AUTHORIZATION_KEY, serializePendingAuthorization(pending))
    const fetchStub: typeof globalThis.fetch = () =>
      Promise.resolve(
        jsonResponse({ error: 'invalid_grant', error_description: 'Invalid authorization grant' })
      )

    // Act
    const result = await runToEither(
      completeSignIn(
        `?code=stale&state=${pending.state}`,
        testEnvironment({ store, fetch: fetchStub })
      )
    )

    // Assert
    if (Either.isRight(result)) throw new Error('expected the rejected grant to fail sign-in')
    expect(result.left._tag).toBe('TokenExchangeFailed')
    expect(result.left.reason).toContain('invalid_grant')
  })

  it('reports an unreachable token endpoint rather than throwing', async () => {
    // Arrange
    const store = memoryStore()
    const pending = stashedRequest()
    store.setItem(PENDING_AUTHORIZATION_KEY, serializePendingAuthorization(pending))

    // Act
    const result = await runToEither(
      completeSignIn(
        `?code=the-code&state=${pending.state}`,
        testEnvironment({ store, fetch: () => Promise.reject(new TypeError('Failed to fetch')) })
      )
    )

    // Assert
    if (Either.isRight(result)) throw new Error('expected the unreachable endpoint to fail sign-in')
    expect(result.left._tag).toBe('PendingRequestUnusable')
    expect(result.left.reason).toContain(pending.tokenEndpoint)
  })
})

// Helpers

/**
 * Run a sign-in Effect to its `Either`, so the tagged error is assertable
 * instead of being thrown out of the test.
 */
const runToEither = <A, E>(effect: Effect.Effect<A, E>): Promise<Either.Either<A, E>> =>
  Effect.runPromise(Effect.either(effect))

/** A `sessionStorage`-shaped store backed by a map, plus a peek at everything in it. */
const memoryStore = (): PendingStore & { contents(): string } => {
  const entries = new Map<string, string>()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
    removeItem: (key) => {
      entries.delete(key)
    },
    contents: () => JSON.stringify([...entries]),
  }
}

/** The environment the flow runs against in tests: real crypto, stubbed edges. */
const testEnvironment = (parts: {
  readonly store: PendingStore
  readonly fetch: typeof globalThis.fetch
}): SignInEnvironment => ({
  fetch: parts.fetch,
  random: globalThis.crypto,
  subtle: globalThis.crypto.subtle,
  store: parts.store,
  redirectUri: REGISTERED_REDIRECT_URI,
  pageIsSecure: true,
})

/** A record shaped like one `beginSignIn` left behind before redirecting. */
const stashedRequest = (): PendingAuthorization => ({
  state: 'a-stashed-state',
  codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  serverUrl: SERVER,
  tokenEndpoint: `${SERVER}/oauth/token`,
})

/** A `fetch` that answers the SMART discovery request and nothing else. */
const discoveryOnly =
  (): typeof globalThis.fetch =>
  (input): Promise<Response> => {
    const url = requestUrl(input)
    if (url.endsWith('/fhir-r4/.well-known/smart-configuration')) {
      return Promise.resolve(
        jsonResponse({
          authorization_endpoint: `${SERVER}/oauth/authorize`,
          token_endpoint: `${SERVER}/oauth/token`,
          code_challenge_methods_supported: ['S256'],
        })
      )
    }
    throw new Error(`unexpected request to ${url}`)
  }

/** A `fetch` that fails the test if the flow calls it. */
const refusingFetch: typeof globalThis.fetch = (input) => {
  throw new Error(`no request was expected, got one to ${requestUrl(input)}`)
}

/** The URL a `fetch` argument names, in any of the three forms it can take. */
const requestUrl = Match.type<RequestInfo | URL>().pipe(
  Match.withReturnType<string>(),
  Match.when(Match.string, (s) => s),
  Match.when({ href: Match.string }, (u) => u.href),
  Match.when({ url: Match.string }, (r) => r.url),
  Match.exhaustive
)

/** A 200 JSON response carrying `body`. */
const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
