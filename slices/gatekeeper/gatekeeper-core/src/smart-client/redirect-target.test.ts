import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { redirectUriForPage, redirectUriForRoute } from './redirect-target.ts'

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

describe('redirectUriForRoute', () => {
  it('resolves the route against the origin, not the page’s own path', () => {
    // Arrange / Act / Assert — the same SPA reached from three of its sections
    // has to send one `redirect_uri`, or only one section could ever sign in.
    expect(redirectUriForRoute('https://wildflowerhealth.io/', '/home')).toBe(
      'https://wildflowerhealth.io/home'
    )
    expect(redirectUriForRoute('https://wildflowerhealth.io/settings/tunnel', '/home')).toBe(
      'https://wildflowerhealth.io/home'
    )
    expect(redirectUriForRoute('http://127.0.0.1:5173/gatekeeper/grants', '/home')).toBe(
      'http://127.0.0.1:5173/home'
    )
  })

  it('drops the query the reader arrived with, including the callback’s own', () => {
    // Arrange — the outbound page carries `?server=`, the callback carries the
    // single-use `code`/`state`. Neither may reach the registered value.
    const outbound = 'https://wildflowerhealth.io/?server=https%3A%2F%2Fx.test#anchor'
    const callback = 'https://wildflowerhealth.io/home?code=abc&state=xyz'

    // Act / Assert
    expect(redirectUriForRoute(outbound, '/home')).toBe('https://wildflowerhealth.io/home')
    expect(redirectUriForRoute(callback, '/home')).toBe('https://wildflowerhealth.io/home')
  })

  it('refuses a route that would point the redirect at another origin', () => {
    // Arrange / Act / Assert — `/\` is the form `URL` folds into `//`, which the
    // origin-equality guard is there to catch.
    const here = 'https://wildflowerhealth.io/'
    expect(redirectUriForRoute(here, '//evil.test/home')).toBeUndefined()
    expect(redirectUriForRoute(here, '/\\evil.test/home')).toBeUndefined()
    expect(redirectUriForRoute(here, 'https://evil.test/home')).toBeUndefined()
  })

  it('applies the same scheme screen as the page form', () => {
    // Arrange / Act / Assert
    expect(redirectUriForRoute('http://localhost:5173/', '/home')).toBe(
      'http://localhost:5173/home'
    )
    expect(redirectUriForRoute('http://preview.example/', '/home')).toBeUndefined()
    expect(redirectUriForRoute('file:///tmp/app/index.html', '/home')).toBeUndefined()
    expect(redirectUriForRoute('', '/home')).toBeUndefined()
  })

  it('always derives the same redirect wherever in the app the flow starts', () => {
    // The server matches `redirect_uri` by exact string equality, and the
    // return leg lands on the fixed route carrying `code` and `state`. The
    // whole point of resolving against the origin is that these two agree
    // however deep the reader was when they started.
    fc.assert(
      fc.property(securePageUrl, fc.webPath(), fc.string(), (href, section, code) => {
        // Arrange
        const started = new URL(href)
        started.pathname = section
        const callback = new URL('/home', href)
        callback.search = new URLSearchParams({ code }).toString()

        // Act / Assert
        expect(redirectUriForRoute(started.href, '/home')).toBe(
          redirectUriForRoute(callback.href, '/home')
        )
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('never yields a URI off the page’s own origin, whatever the route says', () => {
    // A route is app-authored, but the guard is what makes that irrelevant:
    // nothing a route string can spell redirects the token somewhere else.
    fc.assert(
      fc.property(securePageUrl, fc.string(), (href, route) => {
        // Act
        const redirectUri = redirectUriForRoute(href, route)

        // Assert — either refused outright, or provably on this origin and
        // carrying none of the parts a `redirect_uri` must not.
        if (redirectUri === undefined) return
        const parsed = new URL(redirectUri)
        expect(parsed.origin).toBe(new URL(href).origin)
        expect(parsed.username).toBe('')
        expect(parsed.password).toBe('')
        expect(parsed.search).toBe('')
        expect(parsed.hash).toBe('')
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
