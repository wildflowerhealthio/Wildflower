import { Option } from 'effect'
import * as fc from 'fast-check'
import {
  STANDALONE_LAUNCH_SCOPES,
  standaloneLaunchScopeParameter,
  type PendingStore,
  type Session,
  type SignInPage,
} from 'gatekeeper-core/smart-client'
import { numRunsFor } from 'kitchen-sink/test'
import { AuthedUntil, HostAuthed, isAuthed, isFreshlyAuthed } from 'react-kitchen-sink'
import { describe, expect, it } from 'vite-plus/test'

import {
  authStateForSession,
  CLIENT_ID,
  finishSignIn,
  PENDING_AUTHORIZATION_KEY,
  REGISTERED_REDIRECT_URI,
  signInEnvironment,
  startSignIn,
} from './sign-in.ts'

describe('signInEnvironment', () => {
  it('returns to the fixed /home route, not to the section the reader signed in from', () => {
    // Arrange / Act — the same build reached from three of its sections. A
    // directory-derived URI (what the server-docs console uses) would give
    // three different values here and only one could be the registered entry.
    const fromRoot = signInEnvironment(pageAt('https://wildflowerhealth.io/'))
    const fromSection = signInEnvironment(pageAt('https://wildflowerhealth.io/settings/tunnel'))
    const fromDev = signInEnvironment(pageAt('http://127.0.0.1:5173/gatekeeper/grants'))

    // Assert
    expect(fromRoot.redirectUri).toBe('https://wildflowerhealth.io/home')
    expect(fromSection.redirectUri).toBe('https://wildflowerhealth.io/home')
    expect(fromDev.redirectUri).toBe('http://127.0.0.1:5173/home')
  })

  it('falls back to the published URI from an address a sign-in must not return to', () => {
    // Arrange / Act — plaintext off loopback is refused the derivation, and the
    // published value is harmless from a page that can never receive it.
    const environment = signInEnvironment(
      pageAt('http://preview.example/home', { protocol: 'http:' })
    )

    // Assert — pinned to the seeded row's sole entry, which `/oauth/authorize`
    // matches by exact string equality. A drift from
    // `0012_seed_wildflower_react_client` fails the flow at the endpoint.
    expect(environment.redirectUri).toBe(REGISTERED_REDIRECT_URI)
    expect(REGISTERED_REDIRECT_URI).toBe('https://wildflowerhealth.io/app/home')
  })

  it('asks for exactly the scopes the seeded row allows', () => {
    // Arrange / Act
    const environment = signInEnvironment(pageAt('https://wildflowerhealth.io/'))

    // Assert — the wire form is the space-delimited list, in order.
    expect(environment.scope).toBe(STANDALONE_LAUNCH_SCOPES.join(' '))
    expect(environment.scope).toBe(standaloneLaunchScopeParameter())
    expect(environment.clientId).toBe('wildflower-react')
  })

  it('namespaces its pending record to this app', () => {
    // The server-docs console runs the same flow from the same origin, so an
    // un-namespaced key would be one key for both and one tab's return leg
    // could consume a record the other was waiting on.
    expect(PENDING_AUTHORIZATION_KEY.startsWith(`${CLIENT_ID}.`)).toBe(true)
  })

  it('reports the page as secure only on https', () => {
    // Arrange / Act / Assert — this decides whether a plaintext target is
    // reachable at all, so it must follow the page and not a build flag.
    expect(signInEnvironment(pageAt('https://wildflowerhealth.io/')).pageIsSecure).toBe(true)
    expect(
      signInEnvironment(pageAt('http://127.0.0.1:5173/', { protocol: 'http:' })).pageIsSecure
    ).toBe(false)
  })
})

describe('startSignIn', () => {
  it('yields an authorize URL carrying this client’s registration', async () => {
    // Arrange
    const page = pageAt('http://127.0.0.1:5173/', {
      protocol: 'http:',
      fetch: discoveryOnly(),
    })

    // Act
    const started = await startSignIn(SERVER_URL, signInEnvironment(page))

    // Assert
    expect(started.tag).toBe('Ok')
    if (started.tag !== 'Ok') return
    const authorize = new URL(started.value)
    expect(authorize.origin + authorize.pathname).toBe(`${SERVER_URL}/oauth/authorize`)
    expect(authorize.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5173/home')
    expect(authorize.searchParams.get('scope')).toBe(standaloneLaunchScopeParameter())
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('writes the pending record before it yields, under this app’s key', async () => {
    // A caller navigates the moment it has the URL, so a record written after
    // would be a flow whose verifier never survived the redirect.
    const store = memoryStore()
    const page = pageAt('http://127.0.0.1:5173/', {
      protocol: 'http:',
      fetch: discoveryOnly(),
      sessionStorage: store,
    })

    // Act
    await startSignIn(SERVER_URL, signInEnvironment(page))

    // Assert
    expect(store.getItem(PENDING_AUTHORIZATION_KEY)).not.toBeNull()
  })

  it('reports an unreachable server as a reason, not a rejection', async () => {
    // Arrange — discovery fails; the reader gets a sentence, and the caller
    // never has to catch.
    const page = pageAt('http://127.0.0.1:5173/', {
      protocol: 'http:',
      fetch: () => Promise.reject(new Error('connection refused')),
    })

    // Act
    const started = await startSignIn(SERVER_URL, signInEnvironment(page))

    // Assert
    expect(started.tag).toBe('Failed')
    if (started.tag !== 'Failed') return
    expect(started.reason.length).toBeGreaterThan(0)
  })
})

describe('finishSignIn', () => {
  it('redeems a code the flow it started left behind', async () => {
    // Arrange — drive the real round trip rather than a hand-built record, so
    // the `state` and verifier are the ones `startSignIn` actually wrote.
    const store = memoryStore()
    const page = pageAt('http://127.0.0.1:5173/', {
      protocol: 'http:',
      fetch: discoveryAndToken(),
      sessionStorage: store,
    })
    const environment = signInEnvironment(page)
    const started = await startSignIn(SERVER_URL, environment)
    expect(started.tag).toBe('Ok')
    if (started.tag !== 'Ok') return
    const state = new URL(started.value).searchParams.get('state') ?? ''

    // Act — the callback lands on /home with the code and state.
    const completed = await finishSignIn(`?code=the-code&state=${state}`, environment)

    // Assert
    expect(completed.tag).toBe('Ok')
    if (completed.tag !== 'Ok') return
    expect(Option.getOrUndefined(completed.value)).toEqual({
      accessToken: 'tok_hosted',
      scope: 'system/*.cruds',
      serverUrl: SERVER_URL,
      expiresInSeconds: 3600,
    })
    // Single-use: the record is gone, so a replayed callback cannot look
    // legitimate.
    expect(store.getItem(PENDING_AUTHORIZATION_KEY)).toBeNull()
  })

  it('reads an ordinary page load as “not a return leg”', async () => {
    // Arrange — every load asks, because a return leg looks like any other one
    // until the query is read. A load with no pending record must not fail.
    const page = pageAt('https://wildflowerhealth.io/', { fetch: neverCalled })

    // Act
    const completed = await finishSignIn('?server=https%3A%2F%2Fx.test', {
      ...signInEnvironment(page),
    })

    // Assert
    expect(completed.tag).toBe('Ok')
    if (completed.tag !== 'Ok') return
    expect(Option.isNone(completed.value)).toBe(true)
  })

  it('reports the server’s refusal as a reason', async () => {
    // Arrange
    const page = pageAt('https://wildflowerhealth.io/', { fetch: neverCalled })

    // Act — the authorization server bounced the request back as an error.
    const completed = await finishSignIn(
      '?error=access_denied&state=whatever',
      signInEnvironment(page)
    )

    // Assert
    expect(completed.tag).toBe('Failed')
    if (completed.tag !== 'Failed') return
    expect(completed.reason.length).toBeGreaterThan(0)
  })
})

describe('authStateForSession', () => {
  it('publishes a reported lifetime as an expiry the app can check', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 * 60 * 24 }),
        fc.integer({ min: 0, max: 2_000_000_000 }),
        (expiresInSeconds, nowSeconds) => {
          // Act
          const signal = authStateForSession(sessionWith(expiresInSeconds), nowSeconds)

          // Assert — the expiry is the reported lifetime from now, and the
          // session reads as fresh right up to it and not past it.
          expect(signal).toEqual(AuthedUntil({ exp: nowSeconds + expiresInSeconds }))
          expect(isFreshlyAuthed(signal, nowSeconds)).toBe(true)
          expect(isFreshlyAuthed(signal, nowSeconds + expiresInSeconds)).toBe(false)
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('publishes a response with no reported lifetime as authed with no known expiry', () => {
    // `expires_in` is optional in RFC 6749 (gatekeeper always sends it). An
    // invented `exp` would claim a freshness nothing established, so the signal
    // says "authed, expiry unknown" instead.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000 }), (nowSeconds) => {
        // Act
        const signal = authStateForSession(sessionWith(undefined), nowSeconds)

        // Assert
        expect(signal).toEqual(HostAuthed())
        expect(isAuthed(signal)).toBe(true)
        expect(isFreshlyAuthed(signal, nowSeconds)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const SERVER_URL = 'http://127.0.0.1:8080'

/** A session carrying `expiresInSeconds`; nothing else is read by the subject. */
const sessionWith = (expiresInSeconds: number | undefined): Session => ({
  accessToken: 'tok_hosted',
  scope: 'system/*.cruds',
  serverUrl: SERVER_URL,
  expiresInSeconds,
})

/** A `sessionStorage` stand-in with no browser behind it. */
const memoryStore = (): PendingStore => {
  const entries = new Map<string, string>()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
    removeItem: (key) => {
      entries.delete(key)
    },
  }
}

/** A fetch that fails the test if the subject reaches the network at all. */
const neverCalled: typeof globalThis.fetch = () => {
  throw new Error('the subject must not fetch on this path')
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

/** The URL a `fetch` argument names, in each of the three forms it can take. */
const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

/** Answers SMART discovery; anything else is out of scope for the caller. */
const discoveryOnly = (): typeof globalThis.fetch => (input) => {
  const url = requestUrl(input)
  if (url.endsWith('/.well-known/smart-configuration')) {
    return Promise.resolve(
      jsonResponse({
        authorization_endpoint: `${SERVER_URL}/oauth/authorize`,
        token_endpoint: `${SERVER_URL}/oauth/token`,
      })
    )
  }
  return Promise.reject(new Error(`unexpected request to ${url}`))
}

/** Discovery plus a token endpoint that issues one bearer. */
const discoveryAndToken = (): typeof globalThis.fetch => (input, init) => {
  if (requestUrl(input).endsWith('/oauth/token')) {
    expect(init?.method).toBe('POST')
    return Promise.resolve(
      jsonResponse({
        access_token: 'tok_hosted',
        token_type: 'Bearer',
        scope: 'system/*.cruds',
        expires_in: 3600,
      })
    )
  }
  return discoveryOnly()(input, init)
}

/** A {@link SignInPage} served at `href`, with the impure edges stubbed. */
const pageAt = (
  href: string,
  overrides: {
    readonly protocol?: string
    readonly fetch?: typeof globalThis.fetch
    readonly sessionStorage?: PendingStore
  } = {}
): SignInPage => ({
  fetch: overrides.fetch ?? neverCalled,
  // The real Web Crypto: PKCE's verifier and S256 challenge are the subject's
  // own contract with the server, so stubbing them would only weaken the test.
  crypto: globalThis.crypto,
  sessionStorage: overrides.sessionStorage ?? memoryStore(),
  location: { href, protocol: overrides.protocol ?? 'https:' },
})
