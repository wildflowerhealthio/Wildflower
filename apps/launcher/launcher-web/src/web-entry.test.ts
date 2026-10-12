import {
  arrivingSmartLaunchFrom,
  normalizeServerUrl,
} from '@wildflowerhealthio/gatekeeper-core/smart-client'
import { makeBearerAuthStateStore } from '@wildflowerhealthio/gatekeeper-react'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { PENDING_AUTHORIZATION_KEY } from './sign-in.ts'
import {
  chosenServerUrl,
  ehrLaunchIn,
  logoutSettingsItem,
  searchAfterReturnLeg,
  SIGNED_IN_SERVER_KEY,
} from './web-entry.ts'

describe('chosenServerUrl', () => {
  it('should choose the server the tab last signed in to when the URL names none', () => {
    // Arrange — the settled URL names no server; a sign-in kept its server
    // with its bearer.
    const store = memoryStore()
    signInTo(store, RUTH_SERVER_URL)

    // Act
    const chosen = chosenServerUrl('?tab=logs', store)

    // Assert
    expect(chosen).toBe(RUTH_SERVER_URL)
  })

  it('should choose the server ?server= names', () => {
    // Arrange
    const search = `?server=${encodeURIComponent(RUTH_SERVER_URL)}`

    // Act
    const chosen = chosenServerUrl(search, memoryStore())

    // Assert
    expect(chosen).toBe(RUTH_SERVER_URL)
  })

  it('should choose none when neither names one', () => {
    // Arrange / Act
    const chosen = chosenServerUrl('', memoryStore())

    // Assert
    expect(chosen).toBeUndefined()
  })

  it('should prefer a usable ?server= over the remembered server', () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.webUrl(), (rememberedServerUrl, searchServerUrl) => {
        // Arrange
        const store = memoryStore()
        signInTo(store, rememberedServerUrl)
        const search = `?server=${encodeURIComponent(searchServerUrl)}`

        // Act
        const chosen = chosenServerUrl(search, store)

        // Assert
        expect(chosen).toBe(
          normalizeServerUrl(searchServerUrl) ?? normalizeServerUrl(rememberedServerUrl)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('ehrLaunchIn', () => {
  it('should carry the launch, for the server its iss names', () => {
    // Arrange / Act
    const ehrLaunch = ehrLaunchIn(
      `?iss=${encodeURIComponent(`${RUTH_SERVER_URL}/fhir-r4`)}&launch=nonce-1`
    )

    // Assert — the same server `?server=` is set to, so the landing's sign-in
    // on arrival is the one that carries it.
    expect(ehrLaunch).toEqual({ serverUrl: RUTH_SERVER_URL, launch: 'nonce-1' })
  })

  it('should find none in a standalone launch, a lone launch, or an unusable iss', () => {
    // Arrange / Act / Assert
    expect(ehrLaunchIn(`?iss=${encodeURIComponent(RUTH_SERVER_URL)}`)).toBeUndefined()
    expect(ehrLaunchIn('?launch=nonce-1')).toBeUndefined()
    expect(ehrLaunchIn('?iss=javascript%3Aalert(1)&launch=nonce-1')).toBeUndefined()
  })
})

describe('searchAfterReturnLeg', () => {
  it('should point a failed return leg back at the server it was signing in to', () => {
    // Arrange — gatekeeper refused the launch and redirected back.
    const returnSearch = '?error=invalid_request&error_description=Invalid+launch&state=s'

    // Act
    const settled = searchAfterReturnLeg(returnSearch, RUTH_SERVER_URL)

    // Assert
    expect(settled).toBe(`?server=${encodeURIComponent(RUTH_SERVER_URL)}`)
  })

  it("should take out the authorization server's iss, so it never reads as a launch", () => {
    // Arrange — a plain SMART server that names itself in its response
    // (RFC 9207), which is not the FHIR server the sign-in was to.
    const returnSearch = `?error=access_denied&state=s&iss=${encodeURIComponent('https://auth.example.org/realms/r')}`

    // Act
    const settled = searchAfterReturnLeg(returnSearch, RUTH_SERVER_URL)

    // Assert
    expect(settled).toBe(`?server=${encodeURIComponent(RUTH_SERVER_URL)}`)
    expect(Option.isNone(arrivingSmartLaunchFrom(settled))).toBe(true)
  })

  it('should only take the response out when no server is known', () => {
    // Arrange / Act
    const settled = searchAfterReturnLeg(
      `?code=c&state=s&iss=${encodeURIComponent(RUTH_SERVER_URL)}&tab=logs`,
      undefined
    )

    // Assert
    expect(settled).toBe('?tab=logs')
  })
})

describe('logoutSettingsItem', () => {
  it('should leave for the bare landing on logout, clearing the tab’s session storage', async () => {
    // Arrange — a PR preview served under a subpath, signed in to a remote
    // server, with a half-finished sign-in's record also in the tab.
    const page = stubPage()
    const bearerStore = makeBearerAuthStateStore(page.sessionStorage, SIGNED_IN_SERVER_KEY)
    bearerStore.writeSession({ serverUrl: RUTH_SERVER_URL, bearer: 'eyJ.owner.token' })
    page.sessionStorage.setItem(PENDING_AUTHORIZATION_KEY, '{"state":"abc"}')
    const logout = logoutSettingsItem(page, '/staging/pr-7/launcher/', bearerStore)

    // Act
    if (!('onClick' in logout) || logout.onClick === undefined) {
      throw new Error('the logout row is no action row')
    }
    logout.onClick()

    // Assert — the landing at the served base, with no server, in the URL or
    // the tab, to sign back in to, and nothing else left behind.
    expect(await page.assigned).toBe('/staging/pr-7/launcher/')
    expect(page.sessionStorage.getItem(SIGNED_IN_SERVER_KEY)).toBeNull()
    expect(page.sessionStorage.getItem(PENDING_AUTHORIZATION_KEY)).toBeNull()
  })
})

// Helpers

const RUTH_SERVER_URL = 'https://ruth.wildflowerhealth.io'

/** A `sessionStorage` stand-in with no browser behind it. */
const memoryStore = (): Pick<Storage, 'getItem' | 'setItem' | 'clear'> => {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    clear: () => {
      items.clear()
    },
  }
}

/** Sign in to `serverUrl` in `store`, as a redeemed sign-in does. */
const signInTo = (store: Pick<Storage, 'getItem' | 'setItem'>, serverUrl: string): void => {
  makeBearerAuthStateStore(store, SIGNED_IN_SERVER_KEY).writeSession({
    serverUrl,
    bearer: 'eyJ.owner.token',
  })
}

/**
 * A stub page. `assigned` resolves with the first URL the page is sent to.
 * `fetch` answers `204` (logout revocation's response).
 */
const stubPage = (): Parameters<typeof logoutSettingsItem>[0] & {
  readonly assigned: Promise<string>
  readonly sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'clear'>
} => {
  const assignment = Promise.withResolvers<string>()
  return {
    assigned: assignment.promise,
    fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    location: {
      assign: (url: string | URL) => {
        assignment.resolve(String(url))
      },
    },
    sessionStorage: memoryStore(),
  }
}
