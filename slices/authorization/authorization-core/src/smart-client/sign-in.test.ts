import { StorageBlocked } from '@wildflowerhealthio/kitchen-sink'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Either, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  parseRetainedSignInRequest,
  serializeRetainedSignInRequest,
  type RetainedSignInRequest,
} from './authorization-flow.ts'
import { codeChallengeS256 } from './pkce.ts'
import { retainedRequestUnusableFrom } from './sign-in-services.ts'
import type { RetainedRequestStorage } from './sign-in-services.ts'
import {
  jsonResponse,
  memoryStore,
  refuseEveryRequest,
  runToEither,
  testSignInLayer,
  throwingStore,
  type StubAnswer,
} from './sign-in.test-helpers.ts'
import {
  beginSignIn,
  beginSignInAt,
  completeSignIn,
  forgetRetainedSignInRequest,
  peekRetainedSignInRequest,
  type ClientRegistration,
} from './sign-in.ts'
import {
  PlainSmartServer,
  WILDFLOWER_SERVER_CAPABILITY,
  WildflowerServer,
} from './smart-discovery.ts'

const SERVER = 'https://ruth.wildflowerhealth.io'

/** A plain SMART server's FHIR base, and the origin its own OAuth endpoints are on. */
const DEMO_FHIR_BASE = 'https://launch.smarthealthit.org/v/r4/sim/demo/fhir'
const DEMO_AUTH_ORIGIN = 'https://launch.smarthealthit.org/v/r4/sim/demo'

/**
 * An app's registration, standing in for whatever the calling page supplies.
 * Nothing in `sign-in.ts` reads these from a module of its own any more, so the
 * fixture is the whole contract.
 */
const CLIENT_ID = 'a-wildflower-page'
const REDIRECT_URI = 'https://wildflowerhealth.io/a-wildflower-page/'
const SCOPE = 'openid fhirUser system/*.cruds'
const PENDING_KEY = 'a-wildflower-page.pending-authorization'
const REGISTRATION: ClientRegistration = {
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  scope: SCOPE,
}

describe('beginSignIn', () => {
  it('builds an authorization URL from the endpoints the server advertised', async () => {
    // Arrange
    const store = memoryStore()
    const environment = testEnvironment({ store, fetch: discoveryOnly() })

    // Act
    const result = await runToEither(beginSignIn(SERVER, REGISTRATION), environment)

    // Assert
    if (Either.isLeft(result)) throw new Error(result.left.reason)
    const url = new URL(result.right)
    expect(url.origin + url.pathname).toBe(`${SERVER}/oauth/authorize`)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe(SCOPE)
  })

  it('sends whatever registration the caller injected, not one of its own', async () => {
    // The whole point of the move into `authorization-core`: two apps share this
    // flow and each brings its own client id, scopes and redirect URI. Nothing
    // in `sign-in.ts` may fall back to a built-in.
    await fc.assert(
      fc.asyncProperty(
        fc.uuid().map((id) => `client-${id}`),
        fc.uuid().map((id) => `https://wildflowerhealth.io/${id}/`),
        fc.uniqueArray(fc.constantFrom('openid', 'fhirUser', 'launch', 'system/*.cruds'), {
          minLength: 1,
        }),
        async (clientId, redirectUri, scopes) => {
          // Arrange
          const scope = scopes.join(' ')
          const environment = testEnvironment({ store: memoryStore(), fetch: discoveryOnly() })

          // Act
          const result = await runToEither(
            beginSignIn(SERVER, { clientId, redirectUri, scope }),
            environment
          )

          // Assert
          if (Either.isLeft(result)) throw new Error(result.left.reason)
          const url = new URL(result.right)
          expect(url.searchParams.get('client_id')).toBe(clientId)
          expect(url.searchParams.get('redirect_uri')).toBe(redirectUri)
          expect(url.searchParams.get('scope')).toBe(scope)
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('discovers at, and names as its aud, a Wildflower server’s origin, its FHIR base', async () => {
    // Arrange
    const requested: string[] = []
    const discovery = discoveryOnly()
    const environment = testEnvironment({
      store: memoryStore(),
      fetch: (request) => {
        requested.push(request.url)
        return discovery(request)
      },
    })

    // Act
    const result = await runToEither(beginSignIn(SERVER, REGISTRATION), environment)

    // Assert
    if (Either.isLeft(result)) throw new Error(result.left.reason)
    expect(requested).toEqual([`${SERVER}/.well-known/smart-configuration`])
    expect(new URL(result.right).searchParams.get('aud')).toBe(SERVER)
  })

  it('discovers at, and names as its aud, a server URL that is already a FHIR base, and redeems there', async () => {
    // A plain SMART server (the SmartHealthIT demo) is addressed by its FHIR
    // base, which discovery reads, and its endpoints are its own.
    // Arrange
    const store = memoryStore()
    const discovery = discoveryAt(DEMO_FHIR_BASE, DEMO_AUTH_ORIGIN)
    const fetchStub: StubAnswer = (request) =>
      request.url === `${DEMO_AUTH_ORIGIN}/auth/token`
        ? Promise.resolve(
            jsonResponse({ access_token: 'a-token', token_type: 'Bearer', patient: 'a-patient' })
          )
        : discovery(request)
    const environment = testEnvironment({ store, fetch: fetchStub })

    // Act
    const started = await runToEither(beginSignIn(DEMO_FHIR_BASE, REGISTRATION), environment)
    if (Either.isLeft(started)) throw new Error(started.left.reason)
    const url = new URL(started.right)
    const completed = await runToEither(
      completeSignIn(`?code=the-code&state=${url.searchParams.get('state') ?? ''}`, REGISTRATION),
      environment
    )

    // Assert — the return leg needs only what the retained sign-in request carried: the
    // token endpoint discovery found, and the server the session is for, which
    // it names a plain SMART server, with the patient the token response named.
    expect(url.origin + url.pathname).toBe(`${DEMO_AUTH_ORIGIN}/auth/authorize`)
    expect(url.searchParams.get('aud')).toBe(DEMO_FHIR_BASE)
    if (Either.isLeft(completed)) throw new Error(completed.left.reason)
    expect(
      Option.map(completed.right, ({ smartServer, patient }) => ({
        smartServer,
        patient,
      }))
    ).toEqual(
      Option.some({
        smartServer: PlainSmartServer.make({ fhirBaseUrl: DEMO_FHIR_BASE }),
        patient: 'a-patient',
      })
    )
  })

  it('sends the EHR launch it was handed, and keeps it out of the retained sign-in request', async () => {
    // Arrange
    const store = memoryStore()
    const environment = testEnvironment({ store, fetch: discoveryOnly() })

    // Act
    const result = await runToEither(
      beginSignIn(SERVER, REGISTRATION, { launch: 'minted-launch-nonce' }),
      environment
    )

    // Assert
    if (Either.isLeft(result)) throw new Error(result.left.reason)
    const url = new URL(result.right)
    expect(url.searchParams.get('launch')).toBe('minted-launch-nonce')
    expect(url.searchParams.get('aud')).toBe(SERVER)
    expect(store.contents()).not.toContain('minted-launch-nonce')
  })

  it('asks the server to show its limited page again only when told to', async () => {
    // Arrange
    const environment = testEnvironment({ store: memoryStore(), fetch: discoveryOnly() })

    // Act
    const prompting = await runToEither(
      beginSignIn(SERVER, REGISTRATION, { prompt: 'consent' }),
      environment
    )
    const plain = await runToEither(beginSignIn(SERVER, REGISTRATION), environment)

    // Assert
    if (Either.isLeft(prompting)) throw new Error(prompting.left.reason)
    if (Either.isLeft(plain)) throw new Error(plain.left.reason)
    expect(new URL(prompting.right).searchParams.get('prompt')).toBe('consent')
    expect(new URL(plain.right).searchParams.has('prompt')).toBe(false)
  })

  it('stashes the record under the key the caller named, and nowhere else', async () => {
    // Namespacing is what keeps two Wildflower pages on one origin from reading
    // each other's pending request.
    await fc.assert(
      fc.asyncProperty(
        fc.uuid().map((id) => `app-${id}.pending-authorization`),
        async (pendingKey) => {
          // Arrange
          const store = memoryStore()

          // Act
          const result = await runToEither(
            beginSignIn(SERVER, REGISTRATION),
            testEnvironment({ store, fetch: discoveryOnly(), pendingKey })
          )

          // Assert
          if (Either.isLeft(result)) throw new Error(result.left.reason)
          expect(store.getItem(pendingKey)).not.toBeNull()
          expect(store.getItem(PENDING_KEY)).toBeNull()
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('stashes the verifier that matches the challenge it sent', async () => {
    // The two halves of PKCE are minted here and redeemed a page load later, so
    // this is the property that makes the round trip work at all.
    // Arrange
    const store = memoryStore()
    const environment = testEnvironment({ store, fetch: discoveryOnly() })

    // Act
    const result = await runToEither(beginSignIn(SERVER, REGISTRATION), environment)

    // Assert
    if (Either.isLeft(result)) throw new Error(result.left.reason)
    const stashed = parseRetainedSignInRequest(store.getItem(PENDING_KEY))
    if (Option.isNone(stashed)) throw new Error('nothing was stashed')
    const pending = stashed.value
    const url = new URL(result.right)
    expect(url.searchParams.get('code_challenge')).toBe(
      await Effect.runPromise(codeChallengeS256(pending.codeVerifier, globalThis.crypto.subtle))
    )
    expect(url.searchParams.get('state')).toBe(pending.state)
    expect(pending.tokenEndpoint).toBe(`${SERVER}/oauth/token`)
    expect(pending.smartServer).toEqual(WildflowerServer.make({ fhirBaseUrl: SERVER }))
  })

  it('mints a fresh state and verifier for every sign-in', async () => {
    // Arrange
    const first = memoryStore()
    const second = memoryStore()

    // Act
    await runToEither(
      beginSignIn(SERVER, REGISTRATION),
      testEnvironment({ store: first, fetch: discoveryOnly() })
    )
    await runToEither(
      beginSignIn(SERVER, REGISTRATION),
      testEnvironment({ store: second, fetch: discoveryOnly() })
    )

    // Assert
    expect(first.getItem(PENDING_KEY)).not.toBe(second.getItem(PENDING_KEY))
  })

  it('stashes nothing when the target cannot be discovered', async () => {
    // Arrange
    const store = memoryStore()
    const environment = testEnvironment({
      store,
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    })

    // Act
    const result = await runToEither(beginSignIn(SERVER, REGISTRATION), environment)

    // Assert
    if (Either.isRight(result)) throw new Error('expected discovery to fail the sign-in')
    expect(result.left._tag).toBe('DiscoveryFailed')
    expect(store.getItem(PENDING_KEY)).toBeNull()
  })

  it('reports a browser whose session storage refuses the record', async () => {
    // Arrange — Safari in private mode throws on `setItem`.
    const store: RetainedRequestStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError')
      },
      removeItem: () => {},
    }

    // Act
    const result = await runToEither(
      beginSignIn(SERVER, REGISTRATION),
      testEnvironment({ store, fetch: discoveryOnly() })
    )

    // Assert
    if (Either.isRight(result)) throw new Error('expected the blocked storage to fail sign-in')
    expect(result.left._tag).toBe('RetainedRequestUnusable')
    expect(result.left.reason).toContain('session storage')
  })
})

describe('beginSignInAt', () => {
  it('starts at the server it was handed, fetching nothing, and stashes its FHIR base', async () => {
    // Arrange
    const store = memoryStore()
    const environment = testEnvironment({ store, fetch: refuseEveryRequest })
    const discovered = {
      smartServer: PlainSmartServer.make({ fhirBaseUrl: DEMO_FHIR_BASE }),
      endpoints: {
        authorizationEndpoint: `${DEMO_AUTH_ORIGIN}/auth/authorize`,
        tokenEndpoint: `${DEMO_AUTH_ORIGIN}/auth/token`,
      },
      managementEndpoint: Option.none(),
      wildflowerAuthorizationApi: Option.none(),
    }

    // Act
    const result = await runToEither(
      beginSignInAt(discovered, REGISTRATION, { returnTo: '/home', launch: 'launch-1' }),
      environment
    )

    // Assert
    if (Either.isLeft(result)) throw new Error(result.left.reason)
    const url = new URL(result.right)
    expect(url.origin + url.pathname).toBe(`${DEMO_AUTH_ORIGIN}/auth/authorize`)
    expect(url.searchParams.get('aud')).toBe(DEMO_FHIR_BASE)
    expect(url.searchParams.get('launch')).toBe('launch-1')
    const retained = parseRetainedSignInRequest(store.getItem(PENDING_KEY))
    expect(
      Option.map(retained, ({ smartServer, tokenEndpoint, returnTo }) => ({
        smartServer,
        tokenEndpoint,
        returnTo,
      }))
    ).toEqual(
      Option.some({
        smartServer: PlainSmartServer.make({ fhirBaseUrl: DEMO_FHIR_BASE }),
        tokenEndpoint: `${DEMO_AUTH_ORIGIN}/auth/token`,
        returnTo: '/home',
      })
    )
  })
})

describe('completeSignIn', () => {
  it('leaves an ordinary page load alone', async () => {
    // Arrange
    const store = memoryStore()
    store.setItem(PENDING_KEY, serializeRetainedSignInRequest(stashedRequest()))

    // Act
    const result = await runToEither(
      completeSignIn('?server=https%3A%2F%2Fx.test', REGISTRATION),
      testEnvironment({ store, fetch: refuseEveryRequest })
    )

    // Assert
    expect(result).toEqual(Either.right(Option.none()))
    expect(store.getItem(PENDING_KEY)).not.toBeNull()
  })

  it('never redeems a code against another page’s retained sign-in request', async () => {
    // Two sign-in flows on one origin share the tab's `sessionStorage`. A
    // return leg must look only at its own key: reading a neighbour's record
    // would let one flow complete a sign-in the other started.
    // Arrange
    const store = memoryStore()
    const pending = stashedRequest()
    store.setItem('another-page.pending-authorization', serializeRetainedSignInRequest(pending))

    // Act
    const result = await runToEither(
      completeSignIn(`?code=the-code&state=${pending.state}`, REGISTRATION),
      testEnvironment({ store, fetch: refuseEveryRequest })
    )

    // Assert — no token request was made, and the neighbour's record survives.
    if (Either.isRight(result)) throw new Error('expected the stray code to be rejected')
    expect(result.left._tag).toBe('AuthorizationRejected')
    expect(store.getItem('another-page.pending-authorization')).not.toBeNull()
  })

  it('redeems the code and returns the granted session', async () => {
    // Arrange
    const store = memoryStore()
    const pending = stashedRequest()
    store.setItem(PENDING_KEY, serializeRetainedSignInRequest(pending))
    const bodies: string[] = []
    const fetchStub: StubAnswer = async (request) => {
      bodies.push(await request.text())
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
      completeSignIn(`?code=the-code&state=${pending.state}`, REGISTRATION),
      testEnvironment({ store, fetch: fetchStub })
    )

    // Assert
    expect(result).toEqual(
      Either.right(
        Option.some({
          accessToken: 'header.payload.signature',
          scope: 'openid system/*.cruds',
          smartServer: pending.smartServer,
          expiresInSeconds: 3600,
          patient: undefined,
          returnTo: pending.returnTo,
        })
      )
    )
    const sent = new URLSearchParams(bodies[0])
    expect(sent.get('code_verifier')).toBe(pending.codeVerifier)
    expect(sent.get('redirect_uri')).toBe(REDIRECT_URI)
  })

  it('reads a token response that names no scope as granting the requested scope', async () => {
    // RFC 6749 §5.1: a server may leave `scope` out only when it granted what
    // was asked.
    // Arrange
    const store = memoryStore()
    const pending = stashedRequest()
    store.setItem(PENDING_KEY, serializeRetainedSignInRequest(pending))
    const fetchStub: StubAnswer = () =>
      Promise.resolve(jsonResponse({ access_token: 'a-token', token_type: 'Bearer' }))

    // Act
    const result = await runToEither(
      completeSignIn(`?code=the-code&state=${pending.state}`, REGISTRATION),
      testEnvironment({ store, fetch: fetchStub })
    )

    // Assert
    if (Either.isLeft(result)) throw new Error(result.left.reason)
    expect(Option.map(result.right, (session) => session.scope)).toEqual(Option.some(SCOPE))
  })

  it('hands back the returnTo the sign-in was started with', async () => {
    // The redirect URI carries no query, so the return path survives the round
    // trip only through the retained sign-in request `beginSignIn` writes.
    await fc.assert(
      fc.asyncProperty(
        fc.option(
          fc.webPath().filter((path) => path !== ''),
          { nil: undefined }
        ),
        async (returnTo) => {
          // Arrange
          const store = memoryStore()
          const discovery = discoveryOnly()
          const fetchStub: StubAnswer = (request) =>
            request.url === `${SERVER}/oauth/token`
              ? Promise.resolve(jsonResponse({ access_token: 'a-token', token_type: 'Bearer' }))
              : discovery(request)
          const environment = testEnvironment({ store, fetch: fetchStub })
          const started = await runToEither(
            beginSignIn(SERVER, REGISTRATION, { returnTo }),
            environment
          )
          if (Either.isLeft(started)) throw new Error(started.left.reason)
          const state = new URL(started.right).searchParams.get('state') ?? ''

          // Act
          const completed = await runToEither(
            completeSignIn(`?code=the-code&state=${state}`, REGISTRATION),
            environment
          )

          // Assert
          if (Either.isLeft(completed)) throw new Error(completed.left.reason)
          expect(Option.map(completed.right, (session) => session.returnTo)).toEqual(
            Option.some(returnTo)
          )
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('never writes the access token to storage', async () => {
    // The console is a public page and the token can be admin-capable, so it
    // exists only in the caller's memory.
    await fc.assert(
      // JWT-shaped tokens: what an authorization server issues, and free of the JSON
      // punctuation that would make the substring check trivially true.
      fc.asyncProperty(
        fc.uuid().map((id) => `header.${id}.signature`),
        async (accessToken) => {
          // Arrange
          const store = memoryStore()
          const pending = stashedRequest()
          store.setItem(PENDING_KEY, serializeRetainedSignInRequest(pending))
          const fetchStub: StubAnswer = () =>
            Promise.resolve(jsonResponse({ access_token: accessToken, token_type: 'Bearer' }))

          // Act
          await runToEither(
            completeSignIn(`?code=the-code&state=${pending.state}`, REGISTRATION),
            testEnvironment({ store, fetch: fetchStub })
          )

          // Assert
          expect(store.contents()).not.toContain(accessToken)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('consumes the retained sign-in request whatever the outcome', async () => {
    // A record left behind would make a later stray `?code=` look legitimate,
    // so a discarded flow must clear it just as a redeemed one does.
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (succeeds) => {
        // Arrange
        const store = memoryStore()
        const pending = stashedRequest()
        store.setItem(PENDING_KEY, serializeRetainedSignInRequest(pending))
        const fetchStub: StubAnswer = () =>
          Promise.resolve(
            jsonResponse(
              succeeds
                ? { access_token: 'a-token', token_type: 'Bearer' }
                : { error: 'invalid_grant' }
            )
          )

        // Act
        await runToEither(
          completeSignIn(`?code=the-code&state=${pending.state}`, REGISTRATION),
          testEnvironment({ store, fetch: fetchStub })
        )

        // Assert
        expect(store.getItem(PENDING_KEY)).toBeNull()
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('clears the retained sign-in request when the server refuses the authorization', async () => {
    // Arrange
    const store = memoryStore()
    store.setItem(PENDING_KEY, serializeRetainedSignInRequest(stashedRequest()))

    // Act
    const result = await runToEither(
      completeSignIn('?error=access_denied&state=a-stashed-state', REGISTRATION),
      testEnvironment({ store, fetch: refuseEveryRequest })
    )

    // Assert
    expect(Either.isLeft(result)).toBe(true)
    expect(store.getItem(PENDING_KEY)).toBeNull()
  })

  it('routes the redirect-outcome Either through the Effect error channel', async () => {
    // `completeSignIn` yields `authorizationRedirectOutcome`'s `Either` straight
    // into its `Effect.gen`. Effect makes an `Either` yieldable, so a `Left` must
    // arrive on the Effect's error channel — surfaced as the tagged error, not
    // thrown and not swallowed. The whole flow's error handling rests on that, so
    // pin it directly rather than only inferring it from the state-mismatch case.
    // Arrange — a server-refused return is the cleanest Left: no retained sign-in request
    // or state setup is needed to reach it.
    const store = memoryStore()
    store.setItem(PENDING_KEY, serializeRetainedSignInRequest(stashedRequest()))

    // Act
    const result = await runToEither(
      completeSignIn('?error=access_denied&error_description=Owner%20said%20no', REGISTRATION),
      testEnvironment({ store, fetch: refuseEveryRequest })
    )

    // Assert
    if (Either.isRight(result))
      throw new Error('expected the rejected authorization to fail sign-in')
    expect(result.left._tag).toBe('AuthorizationRejected')
    expect(result.left.reason).toBe('The server refused the sign-in. Owner said no')
  })

  it('never redeems a code whose state does not match the stashed one', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((state) => state !== stashedRequest().state),
        async (state) => {
          // Arrange
          const store = memoryStore()
          store.setItem(PENDING_KEY, serializeRetainedSignInRequest(stashedRequest()))
          const requests: string[] = []
          const fetchStub: StubAnswer = (request) => {
            requests.push(request.url)
            return Promise.resolve(jsonResponse({ access_token: 'a-token', token_type: 'Bearer' }))
          }

          // Act
          const result = await runToEither(
            completeSignIn(`?code=the-code&state=${encodeURIComponent(state)}`, REGISTRATION),
            testEnvironment({ store, fetch: fetchStub })
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
    store.setItem(PENDING_KEY, serializeRetainedSignInRequest(pending))
    const fetchStub: StubAnswer = () =>
      Promise.resolve(
        jsonResponse({ error: 'invalid_grant', error_description: 'Invalid authorization grant' })
      )

    // Act
    const result = await runToEither(
      completeSignIn(`?code=stale&state=${pending.state}`, REGISTRATION),
      testEnvironment({ store, fetch: fetchStub })
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
    store.setItem(PENDING_KEY, serializeRetainedSignInRequest(pending))

    // Act
    const result = await runToEither(
      completeSignIn(`?code=the-code&state=${pending.state}`, REGISTRATION),
      testEnvironment({ store, fetch: () => Promise.reject(new TypeError('Failed to fetch')) })
    )

    // Assert
    if (Either.isRight(result)) throw new Error('expected the unreachable endpoint to fail sign-in')
    expect(result.left._tag).toBe('TokenEndpointUnreachable')
    expect(result.left.reason).toContain(pending.tokenEndpoint)
  })

  it('reports a token endpoint that answers with something other than JSON', async () => {
    // Arrange
    const store = memoryStore()
    const pending = stashedRequest()
    store.setItem(PENDING_KEY, serializeRetainedSignInRequest(pending))

    // Act
    const result = await runToEither(
      completeSignIn(`?code=the-code&state=${pending.state}`, REGISTRATION),
      testEnvironment({ store, fetch: () => Promise.resolve(new Response('<html>')) })
    )

    // Assert
    if (Either.isRight(result)) throw new Error('expected the non-JSON answer to fail sign-in')
    expect(result.left).toMatchObject({
      _tag: 'TokenExchangeFailed',
      reason: 'The token endpoint did not answer with JSON.',
    })
  })
})

describe('completeSignIn and the retained sign-in request', () => {
  it('takes the retained sign-in request on a return that carries no code', async () => {
    // Arrange — a `state` alone: another flow's return on the same page
    const store = memoryStore()
    store.setItem(PENDING_KEY, serializeRetainedSignInRequest(stashedRequest()))

    // Act
    const result = await runToEither(
      completeSignIn('?state=another-flow', REGISTRATION),
      testEnvironment({ store, fetch: refuseEveryRequest })
    )

    // Assert
    expect(result).toEqual(Either.right(Option.none()))
    expect(store.getItem(PENDING_KEY)).toBeNull()
  })

  it('leaves a store that throws untouched on an ordinary page load', async () => {
    // Act
    const result = await runToEither(
      completeSignIn('', REGISTRATION),
      testEnvironment({ store: throwingStore(), fetch: refuseEveryRequest })
    )

    // Assert
    expect(result).toEqual(Either.right(Option.none()))
  })

  it('reports a store that refuses to be read on a return leg', async () => {
    // Act
    const result = await runToEither(
      completeSignIn('?code=the-code&state=a-stashed-state', REGISTRATION),
      testEnvironment({ store: throwingStore(), fetch: refuseEveryRequest })
    )

    // Assert
    if (Either.isRight(result)) throw new Error('expected the blocked storage to fail sign-in')
    expect(result.left._tag).toBe('RetainedRequestUnusable')
    expect(result.left.reason).toContain('session storage is blocked')
  })

  it('redeems a retained sign-in request the store gives up but will not remove', async () => {
    // Arrange — a store that reads, but throws on every removal
    const store = memoryStore()
    const pending = stashedRequest()
    store.setItem(PENDING_KEY, serializeRetainedSignInRequest(pending))
    const refusingRemoval: RetainedRequestStorage = {
      ...store,
      removeItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    }
    const answerToken: StubAnswer = () =>
      Promise.resolve(
        jsonResponse({ access_token: 'header.payload.signature', token_type: 'Bearer' })
      )

    // Act
    const result = await runToEither(
      completeSignIn(`?code=the-code&state=${pending.state}`, REGISTRATION),
      testEnvironment({ store: refusingRemoval, fetch: answerToken })
    )

    // Assert
    expect(result).toMatchObject({
      _tag: 'Right',
      right: { _tag: 'Some', value: { accessToken: 'header.payload.signature' } },
    })
  })

  it('reports, and drops, a retained sign-in request that does not read as one', async () => {
    // Arrange — a record a different version of the page wrote
    const store = memoryStore()
    store.setItem(PENDING_KEY, '{"state":"a-stashed-state"}')

    // Act
    const result = await runToEither(
      completeSignIn('?code=the-code&state=a-stashed-state', REGISTRATION),
      testEnvironment({ store, fetch: refuseEveryRequest })
    )

    // Assert
    if (Either.isRight(result)) throw new Error('expected the stale record to fail sign-in')
    expect(result.left._tag).toBe('RetainedRequestUnrecognised')
    expect(result.left.reason).toContain('different version of this page')
    expect(store.getItem(PENDING_KEY)).toBeNull()
  })
})

describe('peekRetainedSignInRequest', () => {
  it('reads the retained sign-in request and leaves it for the return leg', async () => {
    // Arrange
    const store = memoryStore()
    const retained = stashedRequest()
    store.setItem(PENDING_KEY, serializeRetainedSignInRequest(retained))

    // Act
    const result = await runToEither(
      peekRetainedSignInRequest,
      testEnvironment({ store, fetch: refuseEveryRequest })
    )

    // Assert
    expect(result).toEqual(Either.right(Option.some(retained)))
    expect(store.getItem(PENDING_KEY)).not.toBeNull()
  })

  it('reads none when nothing is retained', async () => {
    // Act
    const result = await runToEither(
      peekRetainedSignInRequest,
      testEnvironment({ store: memoryStore(), fetch: refuseEveryRequest })
    )

    // Assert
    expect(result).toEqual(Either.right(Option.none()))
  })

  it('reports a record that does not read as one, and leaves it', async () => {
    // Arrange
    const store = memoryStore()
    store.setItem(PENDING_KEY, '{"state":"a-stashed-state"}')

    // Act
    const result = await runToEither(
      peekRetainedSignInRequest,
      testEnvironment({ store, fetch: refuseEveryRequest })
    )

    // Assert
    expect(Either.isLeft(result) ? result.left._tag : 'read').toBe('RetainedRequestUnrecognised')
    expect(store.getItem(PENDING_KEY)).not.toBeNull()
  })

  it('reports a store that refuses to be read', async () => {
    // Act
    const result = await runToEither(
      peekRetainedSignInRequest,
      testEnvironment({ store: throwingStore(), fetch: refuseEveryRequest })
    )

    // Assert
    expect(Either.isLeft(result) ? result.left._tag : 'read').toBe('RetainedRequestUnusable')
  })
})

describe('forgetRetainedSignInRequest', () => {
  it('drops the retained sign-in request, leaving every other key', async () => {
    // Arrange
    const store = memoryStore()
    store.setItem(PENDING_KEY, serializeRetainedSignInRequest(stashedRequest()))
    store.setItem('another-flow.pending', 'kept')

    // Act
    await Effect.runPromise(
      Effect.provide(
        forgetRetainedSignInRequest,
        testEnvironment({ store, fetch: refuseEveryRequest })
      )
    )

    // Assert
    expect(store.getItem(PENDING_KEY)).toBeNull()
    expect(store.getItem('another-flow.pending')).toBe('kept')
  })

  it('reports a store that refuses removal', async () => {
    // Act
    const result = await runToEither(
      forgetRetainedSignInRequest,
      testEnvironment({ store: throwingStore(), fetch: refuseEveryRequest })
    )

    // Assert
    expect(Either.isLeft(result) ? result.left._tag : 'forgotten').toBe('RetainedRequestUnusable')
  })
})

// Helpers

/** The services the flow runs against in tests: real crypto, stubbed edges. */
const testEnvironment = (parts: {
  readonly store: RetainedRequestStorage
  readonly fetch: StubAnswer
  readonly pendingKey?: string
}): ReturnType<typeof testSignInLayer> =>
  testSignInLayer({
    store: parts.store,
    answer: parts.fetch,
    retainedRequestKey: parts.pendingKey ?? PENDING_KEY,
  })

/** A record shaped like one `beginSignIn` left behind before redirecting. */
const stashedRequest = (): RetainedSignInRequest => ({
  state: 'a-stashed-state',
  codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  smartServer: WildflowerServer.make({ fhirBaseUrl: SERVER }),
  tokenEndpoint: `${SERVER}/oauth/token`,
  returnTo: '/settings/tunnel',
})

/** A `fetch` that answers the SMART discovery request and nothing else. */
const discoveryOnly =
  (): StubAnswer =>
  (request): Promise<Response> => {
    const url = request.url
    if (url === `${SERVER}/.well-known/smart-configuration`) {
      return Promise.resolve(
        jsonResponse({
          authorization_endpoint: `${SERVER}/oauth/authorize`,
          token_endpoint: `${SERVER}/oauth/token`,
          code_challenge_methods_supported: ['S256'],
          capabilities: [WILDFLOWER_SERVER_CAPABILITY],
        })
      )
    }
    throw new Error(`unexpected request to ${url}`)
  }

/**
 * A `fetch` that answers the SMART discovery request under `fhirBaseUrl` as a
 * plain SMART server, with endpoints under `authOrigin`, a 404 for a discovery
 * request anywhere else, and nothing else.
 */
const discoveryAt =
  (fhirBaseUrl: string, authOrigin: string): StubAnswer =>
  (request): Promise<Response> => {
    const url = request.url
    if (url === `${fhirBaseUrl}/.well-known/smart-configuration`) {
      return Promise.resolve(
        jsonResponse({
          authorization_endpoint: `${authOrigin}/auth/authorize`,
          token_endpoint: `${authOrigin}/auth/token`,
        })
      )
    }
    if (url.endsWith('/.well-known/smart-configuration')) {
      return Promise.resolve(new Response('not here', { status: 404 }))
    }
    throw new Error(`unexpected request to ${url}`)
  }

describe('retainedRequestUnusableFrom', () => {
  it.each([
    { operation: 'write', says: 'would not let the page remember the sign-in request' },
    { operation: 'read', says: 'would not let the page use the sign-in request it kept' },
    { operation: 'remove', says: 'would not let the page use the sign-in request it kept' },
  ] as const)('should say what a blocked $operation stopped', ({ operation, says }) => {
    const unusable = retainedRequestUnusableFrom(new StorageBlocked({ operation, key: 'pending' }))

    expect(unusable._tag).toBe('RetainedRequestUnusable')
    expect(unusable.reason).toContain(says)
    expect(unusable.reason).toContain('(session storage is blocked)')
  })
})
