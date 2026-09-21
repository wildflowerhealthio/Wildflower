import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { redirectUriForPage } from './redirect-target.ts'

describe('redirectUriForPage', () => {
  it('derives a page’s own directory, wherever the build is served from', () => {
    // Arrange / Act / Assert — the three addresses one build actually runs at.
    expect(redirectUriForPage('https://wildflowerhealth.io/wildflower-server-docs/')).toBe(
      'https://wildflowerhealth.io/wildflower-server-docs/'
    )
    expect(
      redirectUriForPage(
        'https://wildflowerhealthio.github.io/staging/pr-713/wildflower-server-docs/'
      )
    ).toBe('https://wildflowerhealthio.github.io/staging/pr-713/wildflower-server-docs/')
    expect(redirectUriForPage('http://127.0.0.1:5192/')).toBe('http://127.0.0.1:5192/')
  })

  it('reduces a file within the directory to the directory itself', () => {
    // Arrange
    const href = 'https://wildflowerhealth.io/wildflower-server-docs/index.html'

    // Act
    const redirectUri = redirectUriForPage(href)

    // Assert
    expect(redirectUri).toBe('https://wildflowerhealth.io/wildflower-server-docs/')
  })

  it('drops the console’s own query and fragment', () => {
    // Arrange — a reader deep-linked into a tag with a server already chosen.
    const href =
      'https://wildflowerhealth.io/wildflower-server-docs/?server=https%3A%2F%2Fx.test#tag/apps'

    // Act
    const redirectUri = redirectUriForPage(href)

    // Assert
    expect(redirectUri).toBe('https://wildflowerhealth.io/wildflower-server-docs/')
  })

  it('accepts plain http only on a loopback host', () => {
    // Arrange / Act / Assert
    expect(redirectUriForPage('http://localhost:5192/')).toBe('http://localhost:5192/')
    expect(redirectUriForPage('http://[::1]:5192/')).toBe('http://[::1]:5192/')
    expect(redirectUriForPage('http://preview.example/docs/')).toBeUndefined()
  })

  it('rejects an origin a redirect could not return to', () => {
    // Arrange / Act / Assert
    expect(redirectUriForPage('file:///tmp/docs/index.html')).toBeUndefined()
    expect(redirectUriForPage('blob:https://example.test/abc')).toBeUndefined()
    expect(redirectUriForPage('javascript:alert(1)')).toBeUndefined()
    expect(redirectUriForPage('/wildflower-server-docs/')).toBeUndefined()
    expect(redirectUriForPage('')).toBeUndefined()
  })

  it('always derives the same redirect on the way out and on the way back', () => {
    // The server matches `redirect_uri` by exact string equality, and the
    // return leg arrives at the same page carrying `code` and `state`. If those
    // two derivations ever disagreed, every sign-in would fail at the callback.
    fc.assert(
      fc.property(securePageUrl, fc.string(), fc.string(), (href, code, state) => {
        // Arrange
        const callback = new URL(href)
        callback.search = new URLSearchParams({ code, state }).toString()

        // Act
        const outbound = redirectUriForPage(href)
        const returned = redirectUriForPage(callback.href)

        // Assert
        expect(returned).toBe(outbound)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('always derives a directory that is itself a fixed point', () => {
    fc.assert(
      fc.property(securePageUrl, (href) => {
        // Act
        const once = redirectUriForPage(href)

        // Assert
        expect(once).toBeDefined()
        const value = once ?? ''
        expect(redirectUriForPage(value)).toBe(value)
        expect(value.endsWith('/')).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('never returns a URI carrying credentials, a query or a fragment', () => {
    fc.assert(
      fc.property(securePageUrl, fc.string(), fc.string(), (href, user, password) => {
        // Arrange — userinfo in a redirect would surface in the address bar.
        const withCredentials = new URL(href)
        withCredentials.username = encodeURIComponent(user)
        withCredentials.password = encodeURIComponent(password)

        // Act
        const redirectUri = redirectUriForPage(withCredentials.href)

        // Assert — on the parsed URL, not on the characters: a path may
        // legitimately contain `@`, and only userinfo is the problem.
        expect(redirectUri).toBe(redirectUriForPage(href))
        const parsed = new URL(redirectUri ?? '')
        expect(parsed.username).toBe('')
        expect(parsed.password).toBe('')
        expect(parsed.search).toBe('')
        expect(parsed.hash).toBe('')
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('never accepts a plaintext page off loopback, whatever its path', () => {
    fc.assert(
      fc.property(fc.domain(), fc.webPath(), (domain, path) => {
        // Arrange — a registrable domain is never a loopback host, so the
        // rejection is built into the input rather than filtered for.
        const href = `http://${domain}${path}`

        // Act
        const redirectUri = redirectUriForPage(href)

        // Assert
        expect(redirectUri).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

// Helpers

/**
 * Page addresses a sign-in may be started from: any https URL. `fc.webUrl`
 * emits both schemes, so the scheme is pinned rather than filtered out.
 */
const securePageUrl = fc
  .webUrl({ withQueryParameters: true, withFragments: true })
  .map((url) => url.replace(/^http:/, 'https:'))
