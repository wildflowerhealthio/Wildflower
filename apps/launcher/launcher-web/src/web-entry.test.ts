import {
  arrivingSmartLaunchFrom,
  normalizeServerUrl,
} from '@wildflowerhealthio/gatekeeper-core/smart-client'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { PENDING_AUTHORIZATION_KEY } from './sign-in.ts'
import {
  apiServerUrl,
  DEFAULT_SERVER_URL,
  ehrLaunchIn,
  makeWebEntryOptions,
  rememberSignedInServer,
  searchAfterReturnLeg,
  SIGNED_IN_SERVER_KEY,
  type SignedInServerStore,
} from './web-entry.ts'

describe('apiServerUrl', () => {
  it('should point a load past sign-in at the server the tab remembered', () => {
    // Arrange — the settled URL names no server; the tab remembered the one
    // the sign-in was redeemed against.
    const store = memoryStore()
    rememberSignedInServer(store, RUTH_SERVER_URL)

    // Act
    const apiBaseUrl = apiServerUrl('?tab=logs', store)

    // Assert
    expect(apiBaseUrl).toBe(RUTH_SERVER_URL)
  })

  it('should point a load at the server ?server= names', () => {
    // Arrange
    const search = `?server=${encodeURIComponent(RUTH_SERVER_URL)}`

    // Act
    const apiBaseUrl = apiServerUrl(search, memoryStore())

    // Assert
    expect(apiBaseUrl).toBe(RUTH_SERVER_URL)
  })

  it('should fall back to the loopback server when neither names one', () => {
    // Arrange / Act
    const apiBaseUrl = apiServerUrl('', memoryStore())

    // Assert
    expect(apiBaseUrl).toBe(DEFAULT_SERVER_URL)
  })

  it('should prefer a usable ?server= over the remembered server', () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.webUrl(), (rememberedServerUrl, searchServerUrl) => {
        // Arrange
        const store = memoryStore()
        rememberSignedInServer(store, rememberedServerUrl)
        const search = `?server=${encodeURIComponent(searchServerUrl)}`

        // Act
        const apiBaseUrl = apiServerUrl(search, store)

        // Assert
        expect(apiBaseUrl).toBe(
          normalizeServerUrl(searchServerUrl) ??
            normalizeServerUrl(rememberedServerUrl) ??
            DEFAULT_SERVER_URL
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

describe('makeWebEntryOptions', () => {
  it('should send requests to the server it is given', () => {
    // Arrange
    const page = stubPage()

    // Act
    const options = makeWebEntryOptions(page, '/launcher/', DEFAULT_SERVER_URL)

    // Assert
    expect(options.apiBaseUrl).toBe(DEFAULT_SERVER_URL)
  })

  it('should render no platform banner, since no host runs a server for the page', () => {
    // Arrange / Act
    const options = makeWebEntryOptions(stubPage(), '/launcher/', DEFAULT_SERVER_URL)

    // Assert
    expect(options.platformBanner).toBeNull()
  })

  it('should link other devices to the page’s own origin', () => {
    // Arrange / Act
    const options = makeWebEntryOptions(stubPage(), '/staging/pr-7/launcher/', RUTH_SERVER_URL)

    // Assert
    expect(options.externalLinkRoot()).toBe(PAGE_ORIGIN)
  })

  it('should leave for the bare landing on logout, clearing the tab’s session storage', async () => {
    // Arrange — a PR preview served under a subpath, signed in to a remote
    // server, with a half-finished sign-in's record also in the tab.
    const page = stubPage()
    rememberSignedInServer(page.sessionStorage, RUTH_SERVER_URL)
    page.sessionStorage.setItem(PENDING_AUTHORIZATION_KEY, '{"state":"abc"}')
    const options = makeWebEntryOptions(page, '/staging/pr-7/launcher/', RUTH_SERVER_URL)

    // Act
    logOutWith(options.platformSettingsItems)

    // Assert — the landing at the served base, with no server, in the URL or
    // the tab, to sign back in to, and nothing else left behind.
    expect(await page.assigned).toBe('/staging/pr-7/launcher/')
    expect(page.sessionStorage.getItem(SIGNED_IN_SERVER_KEY)).toBeNull()
    expect(page.sessionStorage.getItem(PENDING_AUTHORIZATION_KEY)).toBeNull()
  })
})

// Helpers

const RUTH_SERVER_URL = 'https://ruth.wildflowerhealth.io'
const PAGE_ORIGIN = 'https://wildflowerhealthio.github.io'

/** A `sessionStorage` stand-in with no browser behind it. */
const memoryStore = (): SignedInServerStore => {
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

/**
 * A stub page. `assigned` resolves with the first URL the page is sent to.
 * `fetch` answers `204` (logout revocation's response).
 */
const stubPage = (): Parameters<typeof makeWebEntryOptions>[0] & {
  readonly assigned: Promise<string>
  readonly sessionStorage: SignedInServerStore
} => {
  const assignment = Promise.withResolvers<string>()
  return {
    assigned: assignment.promise,
    fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    location: {
      origin: PAGE_ORIGIN,
      assign: (url: string | URL) => {
        assignment.resolve(String(url))
      },
    },
    sessionStorage: memoryStore(),
  }
}

/** Click the logout row among `items`, failing when there is none. */
const logOutWith = (
  items: ReturnType<typeof makeWebEntryOptions>['platformSettingsItems']
): void => {
  const logout = items.find((item) => item.id === 'logout')
  if (logout?.onClick === undefined) {
    throw new Error('main-web offers no logout action row')
  }
  logout.onClick()
}
