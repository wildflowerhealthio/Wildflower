import * as fc from 'fast-check'
import type { Session } from 'gatekeeper-core/smart-client'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { apiServerUrlForLoad, DEFAULT_SERVER_URL, makeWebEntryOptions } from './web-entry.ts'

describe('apiServerUrlForLoad', () => {
  it('should point a sign-in return leg at the server the session was redeemed against', () => {
    // Arrange — the registered redirect carries no query of its own, so the
    // callback names no server; only the session knows it.
    const search = '?code=SplxlOBeZQQYbYS6WxSbIA&state=af0ifjsldkj'

    // Act
    const apiBaseUrl = apiServerUrlForLoad(search, sessionOn(RUTH_SERVER_URL))

    // Assert
    expect(apiBaseUrl).toBe(RUTH_SERVER_URL)
  })

  it('should point any other load at the server ?server= names', () => {
    // Arrange
    const search = `?server=${encodeURIComponent(RUTH_SERVER_URL)}`

    // Act
    const apiBaseUrl = apiServerUrlForLoad(search, undefined)

    // Assert
    expect(apiBaseUrl).toBe(RUTH_SERVER_URL)
  })

  it('should fall back to the loopback server when neither names one', () => {
    // Arrange / Act
    const apiBaseUrl = apiServerUrlForLoad('', undefined)

    // Assert
    expect(apiBaseUrl).toBe(DEFAULT_SERVER_URL)
  })

  it('should always prefer the redeemed session over whatever ?server= says', () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.webUrl(), (sessionServerUrl, searchServerUrl) => {
        // Arrange
        const search = `?server=${encodeURIComponent(searchServerUrl)}`

        // Act
        const apiBaseUrl = apiServerUrlForLoad(search, sessionOn(sessionServerUrl))

        // Assert
        expect(apiBaseUrl).toBe(sessionServerUrl)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('makeWebEntryOptions', () => {
  it('should send requests to the server it is given, not one the address bar names', () => {
    // Arrange — the address bar says one server; the caller resolved another.
    const page = pageAt(
      `https://wildflowerhealth.io/app/home?server=${encodeURIComponent(RUTH_SERVER_URL)}`
    )

    // Act
    const options = makeWebEntryOptions(page, '/app/', DEFAULT_SERVER_URL)

    // Assert
    expect(options.apiBaseUrl).toBe(DEFAULT_SERVER_URL)
  })

  it('should leave for the bare landing on logout, naming no server', async () => {
    // Arrange — a PR preview served under a subpath, signed in to a remote server.
    const page = pageAt('https://wildflowerhealthio.github.io/staging/pr-7/app/settings')
    const options = makeWebEntryOptions(page, '/staging/pr-7/app/', RUTH_SERVER_URL)

    // Act
    logOutWith(options.platformSettingsItems)

    // Assert — the landing at the served base, with no `?server=` to sign back in to.
    expect(await page.assigned).toBe('/staging/pr-7/app/')
  })
})

// Helpers

const RUTH_SERVER_URL = 'https://ruth.wildflowerhealth.io'

/** A redeemed session on `serverUrl`; only `serverUrl` matters to these tests. */
const sessionOn = (serverUrl: string): Session => ({
  accessToken: 'eyJ.owner.token',
  scope: 'openid',
  serverUrl,
  expiresInSeconds: 3600,
})

/**
 * A stub page at `href`. `assigned` resolves with the first URL the page is
 * sent to. `fetch` answers `204` (logout revocation's response).
 */
const pageAt = (
  href: string
): Parameters<typeof makeWebEntryOptions>[0] & { readonly assigned: Promise<string> } => {
  const assignment = Promise.withResolvers<string>()
  return {
    assigned: assignment.promise,
    fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    location: {
      href,
      assign: (url: string | URL) => {
        assignment.resolve(String(url))
      },
    },
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
