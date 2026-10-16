import {
  APP_SLUGS,
  POLICY_PATHS,
  restoredUrl,
  sectionUrl,
  type HostedAppId,
} from '@wildflowerhealthio/branding-core'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { APP_REDIRECTS, APEX_REDIRECT_PATHS, redirectPageHtml } from './app-redirects.ts'

describe('APP_REDIRECTS', () => {
  it("should put a page at each app's old apex path, sending it to the app's origin", () => {
    expect(APP_REDIRECTS.map(({ app }) => app).toSorted()).toEqual(
      Object.keys(APP_SLUGS).toSorted()
    )
    expect(APP_REDIRECTS.map(({ file, app }) => [file, sectionUrl(app)])).toEqual(
      expect.arrayContaining([
        ['medications/index.html', 'https://medications.wildflowerhealth.io/'],
        ['health-viewer/index.html', 'https://plots.wildflowerhealth.io/'],
        ['lifting/index.html', 'https://strength.wildflowerhealth.io/'],
        ['ohif-viewer/index.html', 'https://ohif-viewer.wildflowerhealth.io/'],
        ['launcher/index.html', 'https://launcher.wildflowerhealth.io/'],
        ['authorization/index.html', 'https://authorization.wildflowerhealth.io/'],
      ])
    )
  })

  it('should pin the apex redirect paths', () => {
    expect(Object.values(APEX_REDIRECT_PATHS).toSorted()).toEqual(
      [
        'authorization',
        'fhir-sync-pebble',
        'health-viewer',
        'importer',
        'launcher',
        'lifting',
        'medications',
        'ohif-viewer',
        'server-docs',
        'synthetic-data',
        'watch-lifts',
      ].toSorted()
    )
  })

  it("should never put a redirect over one of the site's policy pages", () => {
    const policyPaths: readonly string[] = Object.values(POLICY_PATHS)
    for (const path of Object.values(APEX_REDIRECT_PATHS)) {
      expect(policyPaths).not.toContain(path)
    }
  })
})

describe('redirectPageHtml', () => {
  it("should send a launch to the app's origin with its query and fragment", () => {
    const landed = followRedirect(
      'plots',
      'https://wildflowerhealth.io/health-viewer/?iss=https%3A%2F%2Fruth.example&launch=n1#x'
    )

    expect(landed).toBe(
      'https://plots.wildflowerhealth.io/?iss=https%3A%2F%2Fruth.example&launch=n1#x'
    )
  })

  it('should send a bare visit to the root of the app’s origin', () => {
    expect(followRedirect('strength', 'https://wildflowerhealth.io/lifting/')).toBe(
      'https://strength.wildflowerhealth.io/'
    )
  })

  it('should land a deep link the apex 404.html handed over on the same route of the app', () => {
    fc.assert(
      fc.property(appIdArb, routeArb, queryArb, (app, route, query) => {
        // Arrange — `404.html` sends `/<old>/<route>?<query>` to the page at
        // `/<old>/`, with the path it was asked for in `?redirect=`.
        const oldPath = `/${APEX_REDIRECT_PATHS[app]}/`
        const params = new URLSearchParams(query)
        params.set('redirect', `${oldPath}${route}`)
        const handedOver = `https://wildflowerhealth.io${oldPath}?${params.toString()}`

        // Act — the page redirects, then the app restores the route.
        const landed = new URL(followRedirect(app, handedOver) ?? '')
        const restored = restoredUrl({
          pathname: landed.pathname,
          search: landed.search,
          hash: landed.hash,
        })

        // Assert
        expect(landed.origin).toBe(new URL(sectionUrl(app)).origin)
        const expected = new URL(`/${route}`, landed.origin)
        for (const [key, value] of new URLSearchParams(query)) {
          expected.searchParams.append(key, value)
        }
        expect(restored).toBe(`${expected.pathname}${expected.search}`)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should link the new origin for a browser that runs no script', () => {
    const html = redirectPageHtml('/medications/', 'https://medications.wildflowerhealth.io/')

    expect(html).toContain('content="0; url=https://medications.wildflowerhealth.io/"')
    expect(html).toContain('<a href="https://medications.wildflowerhealth.io/">')
  })
})

// Helpers

const appIdArb = fc.constantFrom<HostedAppId>(...APP_REDIRECTS.map(({ app }) => app))

/** A route below an app's root, relative: `a`, `a/b`, … */
const routeArb = fc
  .array(fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/), { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join('/'))

/** A launch's query, without the `redirect` parameter. */
const queryArb = fc
  .array(
    fc.tuple(
      fc.constantFrom('iss', 'launch', 'server', 'returnTo'),
      fc.stringMatching(/^[A-Za-z0-9]{1,8}$/)
    ),
    { maxLength: 3 }
  )
  .map((pairs) => new URLSearchParams(pairs).toString())

/** Run the page `app`'s old path serves, as a browser would for `href`; where it sent the browser. */
const followRedirect = (app: HostedAppId, href: string): string | undefined => {
  const url = new URL(href)
  let replacedWith: string | undefined
  const window = {
    location: {
      search: url.search,
      hash: url.hash,
      replace: (to: string) => {
        replacedWith = to
      },
    },
  }
  const html = redirectPageHtml(`/${APEX_REDIRECT_PATHS[app]}/`, sectionUrl(app))
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
  // oxlint-disable-next-line typescript/no-implied-eval -- runs the generated page's own script under test
  new Function('window', script)(window)
  return replacedWith
}
