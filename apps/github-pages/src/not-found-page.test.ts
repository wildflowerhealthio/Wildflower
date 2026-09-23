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
    expect(landed).toBe('/app/?x=1&redirect=%2Fapp%2Fgatekeeper%2Fdevices')
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

/**
 * Run 404.html's own script as Pages would for a request to `href`, and return
 * where it sent the browser (root-relative), or `undefined` if it stayed.
 */
const followNotFound = async (
  fetchStub: typeof fetch,
  href: string
): Promise<string | undefined> => {
  const url = new URL(href)
  let replacedWith: string | undefined
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
  // The page's one inline script — an async IIFE reading `window` and `fetch`.
  const script = /<script>([\s\S]*?)<\/script>/.exec(notFoundPage)?.[1] ?? ''
  // oxlint-disable-next-line typescript/no-implied-eval -- runs the checked-in page's own script under test
  new Function('window', 'fetch', script)(window, fetchStub)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return replacedWith
}

/** Where the app lands after `restoreRedirectedUrl`, given the URL 404.html sent it to. */
const restoreAt = (landed: string | undefined): string | undefined => {
  if (landed === undefined) return undefined
  const url = new URL(landed, 'https://example.test')
  return restoredUrl({ pathname: url.pathname, search: url.search, hash: url.hash })
}

const notFoundPage = readFileSync(join(import.meta.dirname, '..', '404.html'), 'utf8')
