import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'
import { restoredUrl } from './spa-redirect.ts'

describe('404.html redirect', () => {
  it("should hand a deep link to its app's root with the full path in ?redirect=", async () => {
    // Arrange — an app's site: its build at the root of its origin.
    const site = pagesSite(['/'])

    // Act
    const landed = await followNotFound(site, 'https://example.test/settings/requests?x=1')

    // Assert
    expect(landed).toEqual({
      _tag: 'Redirected',
      to: '/?x=1&redirect=%2Fsettings%2Frequests',
    })
  })

  it("should hand a PR preview's deep link to that preview's root", async () => {
    // Arrange — the app at the root, and PR 745's preview of it under `/pr-745/`.
    const site = pagesSite(['/', '/pr-745/'])

    // Act
    const landed = await followNotFound(
      site,
      'https://example.test/pr-745/settings/requests?server=s'
    )

    // Assert
    expect(restoreAt(landed)).toBe('/pr-745/settings/requests?server=s')
  })

  it('should show a not-found page for a closed preview rather than fall back to the app', async () => {
    // Arrange — PR 9's preview is gone; the app and PR 745's preview are served.
    const site = pagesSite(['/', '/pr-745/'])

    // Act
    const landed = await followNotFound(site, 'https://example.test/pr-9/devices')

    // Assert
    expect(landed).toEqual({ _tag: 'NotFound', title: 'Page not found' })
  })

  it('should hand a deep link into a preview on a project site to that preview', async () => {
    // Arrange — the marketing site's previews, on the `staging` project site.
    const site = pagesSite(['/staging/pr-745/'])

    // Act
    const landed = await followNotFound(site, 'https://example.test/staging/pr-745/terms/x')

    // Assert
    expect(restoreAt(landed)).toBe('/staging/pr-745/terms/x')
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

  it("should keep a route named like the preview's directory", async () => {
    // App-relative, `?redirect=pr-7` would read as the preview's root itself.
    const landed = await followNotFound(
      pagesSite(['/', '/pr-7/']),
      'https://example.test/pr-7/pr-7'
    )

    expect(restoreAt(landed)).toBe('/pr-7/pr-7')
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

  it('should land a preview deep link in the preview, and a closed one nowhere', async () => {
    await fc.assert(
      fc.asyncProperty(prNumberArb, routeArb, fc.boolean(), async (pr, route, open) => {
        // Arrange — the app at the root, with PR `pr`'s preview open or closed.
        const asked = `/pr-${pr}/${route}`
        const site = pagesSite(open ? ['/', `/pr-${pr}/`] : ['/'])

        // Act
        const landed = await followNotFound(site, `https://example.test${asked}`)

        // Assert
        if (open) expect(restoreAt(landed)).toBe(asked)
        else expect(landed).toEqual({ _tag: 'NotFound', title: 'Page not found' })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('404.html page', () => {
  it('should paint the design system canvas in both color schemes', () => {
    // The redirect page is on screen briefly before it hands off; painting the
    // same canvas the apps do avoids a white flash for dark-mode users.
    // Reading the values from the palette makes this fail if the canvas moves.
    const palette = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        '..',
        'global',
        'react-tundraish',
        'src',
        'colors-custom.css'
      ),
      'utf8'
    )
    const canvases = [...palette.matchAll(/--color-canvas:\s*(#[0-9a-f]{3,8})/gi)].map(
      ([, hex]) => hex ?? ''
    )
    expect(canvases).toHaveLength(2)
    const [light, dark] = canvases
    const [base, darkBlock] = notFoundPage.split('@media (prefers-color-scheme: dark)')
    expect(base).toContain(`background-color: ${light}`)
    expect(darkBlock).toContain(`background-color: ${dark}`)
  })
})

// Helpers

/**
 * URL path segments: no separators, no dots, not empty, and never a preview's
 * `pr-<n>`, which the page treats as a floor.
 */
const segment = fc
  .stringMatching(/^[A-Za-z0-9_-]{1,12}$/)
  .filter((name) => !/^pr-[0-9]+$/.test(name))

/** A PR number. */
const prNumberArb = fc.integer({ min: 1, max: 99_999 })

/** An app directory, slash-suffixed: `/`, `/launcher/`, `/a/b/c/`, … */
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

const notFoundPage = readFileSync(
  join(import.meta.dirname, '..', 'github-pages', '404.html'),
  'utf8'
)
