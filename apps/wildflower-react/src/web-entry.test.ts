import * as fc from 'fast-check'
import { normalizeServerUrl } from 'gatekeeper-core/smart-client'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { PENDING_AUTHORIZATION_KEY } from './sign-in.ts'
import {
  apiServerUrl,
  DEFAULT_SERVER_URL,
  makeWebEntryOptions,
  rememberSignedInServer,
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

describe('makeWebEntryOptions', () => {
  it('should send requests to the server it is given', () => {
    // Arrange
    const page = stubPage()

    // Act
    const options = makeWebEntryOptions(page, '/app/', DEFAULT_SERVER_URL)

    // Assert
    expect(options.apiBaseUrl).toBe(DEFAULT_SERVER_URL)
  })

  it('should link other devices to the page’s own origin', () => {
    // Arrange / Act
    const options = makeWebEntryOptions(stubPage(), '/staging/pr-7/app/', RUTH_SERVER_URL)

    // Assert
    expect(options.externalLinkRoot()).toBe(PAGE_ORIGIN)
  })

  it('should leave for the bare landing on logout, clearing the tab’s session storage', async () => {
    // Arrange — a PR preview served under a subpath, signed in to a remote
    // server, with a half-finished sign-in's record also in the tab.
    const page = stubPage()
    rememberSignedInServer(page.sessionStorage, RUTH_SERVER_URL)
    page.sessionStorage.setItem(PENDING_AUTHORIZATION_KEY, '{"state":"abc"}')
    const options = makeWebEntryOptions(page, '/staging/pr-7/app/', RUTH_SERVER_URL)

    // Act
    logOutWith(options.platformSettingsItems)

    // Assert — the landing at the served base, with no server, in the URL or
    // the tab, to sign back in to, and nothing else left behind.
    expect(await page.assigned).toBe('/staging/pr-7/app/')
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
