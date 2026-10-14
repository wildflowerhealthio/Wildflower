import { describe, expect, it } from 'vite-plus/test'

import { browserBoot, deepRouteOf, type BootPage } from './boot.ts'

describe('browserBoot', () => {
  it('lands signed out on the server ?iss= names', async () => {
    // Arrange
    const page = stubPage(`/authorization/?iss=${encodeURIComponent(SERVER_URL)}`)

    // Act
    const boot = await browserBoot(page, '/authorization/')

    // Assert
    expect(boot.tag).toBe('SignedOut')
    expect(boot.tag === 'SignedOut' ? boot.landing.arrivalServerUrl : undefined).toBe(SERVER_URL)
  })

  it('signs in from ?iss= and settles on where the reader was headed, still naming the server', async () => {
    // Arrange — a deep link opened signed out starts its sign-in from the landing.
    const page = stubPage(`/authorization/approved/grant-1?iss=${encodeURIComponent(SERVER_URL)}`)
    const arrival = await browserBoot(page, '/authorization/')
    if (arrival.tag !== 'SignedOut') throw new Error('expected the landing')
    const started = await arrival.landing.signIn.start(SERVER_URL)
    const state = new URL(started.tag === 'Ok' ? started.value : '').searchParams.get('state')
    // The authorization server sends the reader back to the app root.
    page.navigate(
      `/authorization/?code=code-1&state=${state ?? ''}&iss=${encodeURIComponent(SERVER_URL)}`
    )

    // Act
    const returned = await browserBoot(page, '/authorization/')

    // Assert
    expect(returned.tag).toBe('SignedIn')
    expect(returned.tag === 'SignedIn' ? returned.session.accessToken : undefined).toBe('tok_owner')
    expect(page.url()).toBe(`/authorization/approved/grant-1?iss=${encodeURIComponent(SERVER_URL)}`)
  })

  it('points ?iss= back at the server a failed sign-in was to', async () => {
    // Arrange
    const page = stubPage('/authorization/')
    const arrival = await browserBoot(page, '/authorization/')
    if (arrival.tag !== 'SignedOut') throw new Error('expected the landing')
    await arrival.landing.signIn.start(SERVER_URL)
    page.navigate('/authorization/?error=access_denied')

    // Act
    const returned = await browserBoot(page, '/authorization/')

    // Assert
    expect(page.url()).toBe(`/authorization/?iss=${encodeURIComponent(SERVER_URL)}`)
    expect(returned.tag === 'SignedOut' ? returned.landing.bootSignInProblem?.serverUrl : '').toBe(
      SERVER_URL
    )
  })
})

describe('deepRouteOf', () => {
  it('names a route below the app root, and none for the root itself', () => {
    expect(deepRouteOf('/authorization/approved/grant-1', '/authorization/')).toBe(
      '/approved/grant-1'
    )
    expect(deepRouteOf('/authorization/', '/authorization/')).toBeUndefined()
    expect(deepRouteOf('/elsewhere/', '/authorization/')).toBeUndefined()
  })
})

// Helpers

/** The URL a `fetch` was called with. */
const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

const SERVER_URL = 'https://ruth.wildflowerhealth.io'

/** The SMART configuration a Wildflower server serves. */
const wildflowerConfiguration = {
  issuer: SERVER_URL,
  authorization_endpoint: `${SERVER_URL}/oauth/authorize`,
  token_endpoint: `${SERVER_URL}/oauth/token`,
  wildflower_authorization_api: `${SERVER_URL}/authorization/`,
  capabilities: ['wildflower-server'],
}

/**
 * The published page at `path`, whose `history.replaceState` and `navigate`
 * move its location, over a `fetch` that answers as a Wildflower server.
 */
const stubPage = (
  path: string
): BootPage & { readonly navigate: (path: string) => void; readonly url: () => string } => {
  let current = new URL(path, 'https://wildflowerhealth.io')
  const store = new Map<string, string>()
  return {
    navigate: (next) => {
      current = new URL(next, current)
    },
    url: () => `${current.pathname}${current.search}`,
    fetch: (input) => {
      const url = urlOf(input)
      if (url.endsWith('/.well-known/smart-configuration')) {
        return Promise.resolve(Response.json(wildflowerConfiguration))
      }
      return Promise.resolve(
        Response.json({ access_token: 'tok_owner', token_type: 'Bearer', expires_in: 900 })
      )
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
    location: {
      get href() {
        return current.href
      },
      get protocol() {
        return current.protocol
      },
      get pathname() {
        return current.pathname
      },
      get search() {
        return current.search
      },
      assign: () => {},
    },
    history: {
      replaceState: (_data, _unused, url) => {
        current = new URL(String(url), current)
      },
    },
  }
}
