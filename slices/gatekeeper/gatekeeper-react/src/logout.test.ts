import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { AuthedUntil } from 'react-kitchen-sink'
import { describe, expect, it } from 'vite-plus/test'
import { makeBearerAuthStateStore } from './client/bearer-auth-state-store.ts'
import { gatekeeperLogoutSettingsItem, logOutBearerSession } from './logout.ts'

describe('logOutBearerSession', () => {
  it('should revoke the held bearer at the server’s logout endpoint', async () => {
    // Arrange
    const store = signedInStore('eyJ.owner.token')
    const requests = recordingFetch()

    // Act
    await logOutBearerSession({
      apiBaseUrl: 'https://abc.tunnel.example',
      bearerStore: store,
      fetch: requests.fetch,
      leave: () => {},
    })

    // Assert
    expect(requests.seen).toEqual([
      {
        url: 'https://abc.tunnel.example/access/logout',
        method: 'POST',
        authorization: 'Bearer eyJ.owner.token',
        redirect: 'manual',
      },
    ])
  })

  it('should forget the bearer and leave for the landing page', async () => {
    // Arrange
    const store = signedInStore('eyJ.owner.token')
    let left = false

    // Act
    await logOutBearerSession({
      apiBaseUrl: 'https://abc.tunnel.example',
      bearerStore: store,
      fetch: recordingFetch().fetch,
      leave: () => {
        left = true
      },
    })

    // Assert
    expect(store.bearer()).toBeUndefined()
    expect(left).toBe(true)
  })

  it('should forget the bearer before the revoke request goes out', async () => {
    // Arrange
    const store = signedInStore('eyJ.owner.token')
    let bearerWhileRevoking: string | undefined = 'not observed'

    // Act
    await logOutBearerSession({
      apiBaseUrl: 'https://abc.tunnel.example',
      bearerStore: store,
      fetch: () => {
        bearerWhileRevoking = store.bearer()
        return Promise.resolve(new Response(null, { status: 204 }))
      },
      leave: () => {},
    })

    // Assert
    expect(bearerWhileRevoking).toBeUndefined()
  })

  it('should still log out and leave when the server cannot be reached', async () => {
    // Arrange
    const store = signedInStore('eyJ.owner.token')
    let left = false

    // Act
    await logOutBearerSession({
      apiBaseUrl: 'https://abc.tunnel.example',
      bearerStore: store,
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      leave: () => {
        left = true
      },
    })

    // Assert
    expect(store.bearer()).toBeUndefined()
    expect(left).toBe(true)
  })

  it('should not call the server when no bearer is held', async () => {
    // Arrange
    const store = makeBearerAuthStateStore()
    const requests = recordingFetch()

    // Act
    await logOutBearerSession({
      apiBaseUrl: 'https://abc.tunnel.example',
      bearerStore: store,
      fetch: requests.fetch,
      leave: () => {},
    })

    // Assert
    expect(requests.seen).toEqual([])
  })

  it('should always address the logout endpoint directly under the server origin', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .webUrl({ withQueryParameters: false, withFragments: false })
          .map((url) => new URL(url).origin),
        fc.nat({ max: 3 }),
        fc.string({ minLength: 1 }),
        async (origin, trailingSlashes, token) => {
          // Arrange
          const requests = recordingFetch()

          // Act
          await logOutBearerSession({
            apiBaseUrl: `${origin}${'/'.repeat(trailingSlashes)}`,
            bearerStore: signedInStore(token),
            fetch: requests.fetch,
            leave: () => {},
          })

          // Assert
          expect(requests.seen.map((request) => request.url)).toEqual([`${origin}/access/logout`])
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('gatekeeperLogoutSettingsItem', () => {
  it('should be an action row titled Logout that logs the session out when selected', async () => {
    // Arrange
    const store = signedInStore('eyJ.owner.token')
    const left = Promise.withResolvers<undefined>()
    const item = gatekeeperLogoutSettingsItem({
      apiBaseUrl: 'https://abc.tunnel.example',
      bearerStore: store,
      fetch: recordingFetch().fetch,
      leave: () => left.resolve(undefined),
    })

    // Act
    if (!('onClick' in item) || item.onClick === undefined)
      throw new Error('expected an action row')
    item.onClick()
    await left.promise

    // Assert
    expect(item.title).toBe('Logout')
    expect(store.bearer()).toBeUndefined()
  })
})

// Helpers

interface SeenRequest {
  readonly url: string
  readonly method: string | undefined
  readonly authorization: string | null
  readonly redirect: RequestRedirect | undefined
}

/** A `fetch` stub that answers `204` and keeps what each call asked for. */
const recordingFetch = (): { readonly fetch: typeof fetch; readonly seen: SeenRequest[] } => {
  const seen: SeenRequest[] = []
  const stub: typeof fetch = (input, init) => {
    seen.push({
      url: new Request(input).url,
      method: init?.method,
      authorization: new Headers(init?.headers).get('Authorization'),
      redirect: init?.redirect,
    })
    return Promise.resolve(new Response(null, { status: 204 }))
  }
  return { fetch: stub, seen }
}

/** A bearer store holding `token`, signed in until 2100. */
const signedInStore = (token: string): ReturnType<typeof makeBearerAuthStateStore> => {
  const store = makeBearerAuthStateStore()
  store.writeBearer(token)
  store.setAuthState(AuthedUntil({ exp: 4_102_444_800 }))
  return store
}
