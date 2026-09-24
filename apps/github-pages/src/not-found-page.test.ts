import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { restoredUrl } from 'branding-core'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

describe('404.html redirect', () => {
  it('should hand a deep link to its app root with the full path in ?redirect=', async () => {
    // Arrange — a deep link into the `/app/` section.
    const site = pagesSite(['/app/'])

    // Act
    const landed = await followNotFound(site, 'https://example.test/app/gatekeeper/devices?x=1')

    // Assert
    expect(landed).toEqual({
      _tag: 'Redirected',
      to: '/app/?x=1&redirect=%2Fapp%2Fgatekeeper%2Fdevices',
    })
  })

  it('should hand a PR preview deep link to that preview app root', async () => {
    // Arrange — the staging site: previews under `/staging/pr-<n>/`, nothing at the root.
    const site = pagesSite(['/staging/pr-745/', '/staging/pr-745/app/'])

    // Act
    const landed = await followNotFound(
      site,
      'https://example.test/staging/pr-745/app/gatekeeper/oauth-polling/1?server=s'
    )

    // Assert
    expect(restoreAt(landed)).toBe('/staging/pr-745/app/gatekeeper/oauth-polling/1?server=s')
  })

  it('should show a not-found page when a closed preview has no ancestor to redirect to', async () => {
    // Arrange — PR 9's preview is gone; only PR 745's is served.
    const site = pagesSite(['/staging/pr-745/', '/staging/pr-745/app/'])

    // Act
    const landed = await followNotFound(site, 'https://example.test/staging/pr-9/app/devices')

    // Assert
    expect(landed).toEqual({ _tag: 'NotFound', title: 'Page not found' })
  })

  it('should show a not-found page for the site root when nothing is served there', async () => {
    const landed = await followNotFound(pagesSite([]), 'https://example.test/')

    expect(landed).toEqual({ _tag: 'NotFound', title: 'Page not found' })
  })

  it('should never leave the page blank when nothing on the path is served', async () => {
    await fc.assert(
      fc.asyncProperty(appDirArb, routeArb, async (unservedDir, route) => {
        // Arrange — a site serving nothing at all, asked for any path.
        const asked = `${unservedDir}${route}`

        // Act
        const landed = await followNotFound(pagesSite([]), `https://example.test${asked}`)

        // Assert
        expect(landed).toEqual({ _tag: 'NotFound', title: 'Page not found' })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should keep a route named like the app directory', async () => {
    // App-relative, `?redirect=/app` would read as the app root itself.
    const landed = await followNotFound(pagesSite(['/app/']), 'https://example.test/app/app')

    expect(restoreAt(landed)).toBe('/app/app')
  })

  it('should always land the app exactly where the browser asked to go', async () => {
    await fc.assert(
      fc.asyncProperty(appDirArb, routeArb, async (appDir, route) => {
        // Arrange — a site with one app at `appDir`, asked for a path below it.
        const asked = `${appDir}${route}`

        // Act — 404.html redirects, then the app restores.
        const landed = await followNotFound(pagesSite([appDir]), `https://example.test${asked}`)

        // Assert
        expect(restoreAt(landed)).toBe(asked)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** URL path segments: no separators, no dots, not empty. */
const segment = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/)

/** An app directory, slash-suffixed: `/`, `/app/`, `/staging/pr-7/app/`, … */
const appDirArb = fc
  .array(segment, { maxLength: 3 })
  .map((segments) => (segments.length === 0 ? '/' : `/${segments.join('/')}/`))

/** A route below the app directory, relative: `a`, `a/b`, … */
const routeArb = fc.array(segment, { minLength: 1, maxLength: 3 }).map((s) => s.join('/'))

/** The URL a `fetch` call asked for — 404.html passes root-relative strings. */
const requestedUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** A Pages site that serves an `index.html` in each of `appDirs`, and nothing else. */
const pagesSite =
  (appDirs: readonly string[]): typeof fetch =>
  (input) => {
    const path = new URL(requestedUrl(input), 'https://example.test').pathname
    const served = appDirs.some((dir) => path === `${dir}index.html`)
    return Promise.resolve(new Response(null, { status: served ? 200 : 404 }))
  }

/** What 404.html did with a request once its script settled. */
type Landing =
  /** Sent the browser to `to` (root-relative). */
  | { readonly _tag: 'Redirected'; readonly to: string }
  /** Turned itself into the not-found page, retitled `title`. */
  | { readonly _tag: 'NotFound'; readonly title: string }
  /** Did neither — the blank "Redirecting…" tab the page must never leave up. */
  | { readonly _tag: 'Blank' }

/** Run 404.html's own script as Pages would for a request to `href`. */
const followNotFound = async (fetchStub: typeof fetch, href: string): Promise<Landing> => {
  const url = new URL(href)
  let replacedWith: string | undefined
  const dataset: Record<string, string> = {}
  const document = { title: 'Redirecting…', documentElement: { dataset } }
  const window = {
    location: {
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      replace: (to: string) => {
        replacedWith = to
      },
    },
  }
  // The page's one inline script — an async IIFE reading `window`, `document` and `fetch`.
  const script = /<script>([\s\S]*?)<\/script>/.exec(notFoundPage)?.[1] ?? ''
  // oxlint-disable-next-line typescript/no-implied-eval -- runs the checked-in page's own script under test
  new Function('window', 'document', 'fetch', script)(window, document, fetchStub)
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (replacedWith !== undefined) return { _tag: 'Redirected', to: replacedWith }
  if ('notFound' in document.documentElement.dataset) {
    return { _tag: 'NotFound', title: document.title }
  }
  return { _tag: 'Blank' }
}

/** Where the app lands after `restoreRedirectedUrl`, given where 404.html sent it. */
const restoreAt = (landed: Landing): string | undefined => {
  if (landed._tag !== 'Redirected') return undefined
  const url = new URL(landed.to, 'https://example.test')
  return restoredUrl({ pathname: url.pathname, search: url.search, hash: url.hash })
}

const notFoundPage = readFileSync(join(import.meta.dirname, '..', '404.html'), 'utf8')
