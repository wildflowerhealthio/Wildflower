import type { SignInPage } from '@wildflowerhealthio/authorization-core/smart-client'
import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  AUTHORIZATION_CLIENT_ID,
  AUTHORIZATION_SCOPE,
  PENDING_AUTHORIZATION_KEY,
} from './config.ts'
import {
  finishSignIn,
  inAppReturnPath,
  NOT_A_WILDFLOWER_SERVER,
  signInEnvironment,
  startSignIn,
} from './sign-in.ts'

describe('startSignIn', () => {
  it('leaves for a Wildflower server’s authorization endpoint as the app’s own client', async () => {
    // Arrange
    const page = stubPage({ smartConfiguration: wildflowerConfiguration })

    // Act
    const started = await startSignIn(SERVER_URL, undefined, signInEnvironment(page, '/'))

    // Assert
    expect(started.tag).toBe('Ok')
    const authorizationUrl = new URL(started.tag === 'Ok' ? started.value : '')
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      `${SERVER_URL}/oauth/authorize`
    )
    expect(authorizationUrl.searchParams.get('client_id')).toBe(AUTHORIZATION_CLIENT_ID)
    expect(authorizationUrl.searchParams.get('scope')).toBe(AUTHORIZATION_SCOPE)
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(
      'https://authorization.wildflowerhealth.io/'
    )
    expect(authorizationUrl.searchParams.get('aud')).toBe(SERVER_URL)
    expect(page.store.has(PENDING_AUTHORIZATION_KEY)).toBe(true)
  })

  it('refuses a server that isn’t a Wildflower server before leaving', async () => {
    // Arrange — a plain SMART server: its configuration lists no
    // `wildflower-server` capability.
    const page = stubPage({ smartConfiguration: plainSmartConfiguration })

    // Act
    const started = await startSignIn(SERVER_URL, undefined, signInEnvironment(page, '/'))

    // Assert
    expect(started).toEqual({ tag: 'Failed', reason: NOT_A_WILDFLOWER_SERVER })
    expect(NOT_A_WILDFLOWER_SERVER).toMatch(/^This isn't a Wildflower server\./)
    expect(page.store.size).toBe(0)
  })
})

describe('finishSignIn', () => {
  it('redeems the code into a session with the server’s authorization API', async () => {
    // Arrange — a sign-in started from a deep link, now back with its code.
    const page = stubPage({ smartConfiguration: wildflowerConfiguration })
    const environment = signInEnvironment(page, '/')
    const started = await startSignIn(SERVER_URL, '/approved/grant-1', environment)
    const state = new URL(started.tag === 'Ok' ? started.value : '').searchParams.get('state')

    // Act
    const finished = await finishSignIn(`?code=code-1&state=${state ?? ''}`, environment)

    // Assert
    expect(finished).toEqual({
      tag: 'Ok',
      value: Option.some({
        serverUrl: SERVER_URL,
        authorizationApiUrl: `${SERVER_URL}/authorization/`,
        accessToken: 'tok_owner',
        returnTo: '/approved/grant-1',
      }),
    })
    expect(page.store.size).toBe(0)
  })

  it('is no sign-in on an ordinary load', async () => {
    const page = stubPage({ smartConfiguration: wildflowerConfiguration })

    const finished = await finishSignIn('?iss=x', signInEnvironment(page, '/'))

    expect(finished).toEqual({ tag: 'Ok', value: Option.none() })
  })

  it('names the server a refused sign-in was to', async () => {
    // Arrange
    const page = stubPage({ smartConfiguration: wildflowerConfiguration })
    const environment = signInEnvironment(page, '/')
    await startSignIn(SERVER_URL, undefined, environment)

    // Act
    const finished = await finishSignIn('?error=access_denied', environment)

    // Assert
    expect(finished.tag === 'Failed' ? finished.problem.serverUrl : undefined).toBe(SERVER_URL)
  })
})

describe('inAppReturnPath', () => {
  it('keeps a same-origin path and falls back to the root for anything else', () => {
    expect(inAppReturnPath('/approved/grant-1')).toBe('/approved/grant-1')
    expect(inAppReturnPath(undefined)).toBe('/')
    expect(inAppReturnPath('https://evil.test/')).toBe('/')
    expect(inAppReturnPath('//evil.test/')).toBe('/')
    expect(inAppReturnPath('/\\evil.test/')).toBe('/')
  })
})

// Helpers

/** The URL a `fetch` was called with. */
const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

const SERVER_URL = 'https://ruth.wildflowerhealth.io'

/** The SMART configuration a Wildflower server serves, as `fhir-r4-rust` snapshots it. */
const wildflowerConfiguration = {
  issuer: SERVER_URL,
  authorization_endpoint: `${SERVER_URL}/oauth/authorize`,
  token_endpoint: `${SERVER_URL}/oauth/token`,
  management_endpoint: `https://authorization.wildflowerhealth.io/?iss=${encodeURIComponent(SERVER_URL)}`,
  wildflower_authorization_api: `${SERVER_URL}/authorization/`,
  code_challenge_methods_supported: ['S256'],
  capabilities: ['launch-ehr', 'client-public', 'wildflower-server'],
}

/** A plain SMART server's configuration: no `wildflower-server` capability, no authorization API. */
const plainSmartConfiguration = {
  authorization_endpoint: `${SERVER_URL}/oauth/authorize`,
  token_endpoint: `${SERVER_URL}/oauth/token`,
  code_challenge_methods_supported: ['S256'],
  capabilities: ['launch-ehr', 'client-public'],
}

/**
 * The published page at `/authorization/`, over a `fetch` that answers the
 * SMART configuration with `smartConfiguration` and the token endpoint with a
 * bearer, and a `sessionStorage` kept in `store`.
 */
const stubPage = (options: {
  readonly smartConfiguration: unknown
}): SignInPage & { readonly store: Map<string, string> } => {
  const store = new Map<string, string>()
  return {
    store,
    fetch: (input) => {
      const url = urlOf(input)
      if (url.endsWith('/.well-known/smart-configuration')) {
        return Promise.resolve(Response.json(options.smartConfiguration))
      }
      if (url === `${SERVER_URL}/oauth/token`) {
        return Promise.resolve(
          Response.json({ access_token: 'tok_owner', token_type: 'Bearer', expires_in: 900 })
        )
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    },
    crypto: globalThis.crypto,
    sessionStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value)
      },
      removeItem: (key) => {
        store.delete(key)
      },
    },
    location: { href: 'https://authorization.wildflowerhealth.io/', protocol: 'https:' },
  }
}
