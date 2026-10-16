import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

import {
  APEX_REDIRECT_PATHS,
  HOSTED_APP_IDS,
  redirectStubHtml,
  resolvePublishedSites,
} from './published-sites.ts'

const assembledDir = '/repo/dist'
const outDir = '/repo/dist-published'

describe('resolvePublishedSites', () => {
  const sites = resolvePublishedSites(assembledDir, outDir)

  it('should stage every hosted app from its slug directory, for its own origin', () => {
    expect(sites.apps.map(({ app }) => app).toSorted()).toEqual(Object.keys(APP_SLUGS).toSorted())
    for (const site of sites.apps) {
      expect(site.from).toBe(join(assembledDir, APP_SLUGS[site.app]))
      expect(site.to).toBe(join(outDir, 'apps', APP_SLUGS[site.app]))
      expect(site.customDomain).toBe(`${APP_SLUGS[site.app]}.wildflowerhealth.io`)
      expect(`https://${site.customDomain}/`).toBe(sectionUrl(site.app))
    }
  })

  it("should leave every app's directory out of the apex", () => {
    expect(sites.appDirsInAssembly.toSorted()).toEqual(
      sites.apps.map(({ from }) => from).toSorted()
    )
  })

  it("should put a stub at each app's old apex path, sending it to the app's origin", () => {
    expect(sites.redirects.map(({ fromPath, to }) => [fromPath, to])).toEqual(
      expect.arrayContaining([
        ['/medications/', 'https://medications.wildflowerhealth.io/'],
        ['/health-viewer/', 'https://plots.wildflowerhealth.io/'],
        ['/lifting/', 'https://strength.wildflowerhealth.io/'],
        ['/ohif-viewer/', 'https://ohif-viewer.wildflowerhealth.io/'],
        ['/launcher/', 'https://launcher.wildflowerhealth.io/'],
        ['/authorization/', 'https://authorization.wildflowerhealth.io/'],
      ])
    )
    for (const redirect of sites.redirects) {
      expect(redirect.stubPath).toBe(
        join(outDir, 'apex', APEX_REDIRECT_PATHS[redirect.app], 'index.html')
      )
      expect(redirect.to).toBe(sectionUrl(redirect.app))
    }
  })

  it('should pin the old apex paths', () => {
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

  it("should never put a stub over one of the marketing site's pages", () => {
    const policyPaths: readonly string[] = Object.values(POLICY_PATHS)
    for (const path of Object.values(APEX_REDIRECT_PATHS)) {
      expect(policyPaths).not.toContain(path)
    }
  })
})

describe('deploy-github-pages.yml', () => {
  it("should mint its push token for exactly the apps' Pages repositories", () => {
    // Arrange — the newline-separated `repositories:` block of the token step.
    const workflow = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        '..',
        '.github',
        'workflows',
        'deploy-github-pages.yml'
      ),
      'utf8'
    )
    const block = /repositories: \|\n((?:\s+[\w-]+\n)+)/.exec(workflow)?.[1] ?? ''

    // Act
    const repositories = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')

    // Assert — a repository missing here fails that app's push.
    expect(repositories.toSorted()).toEqual(
      Object.values(APP_SLUGS)
        .map((slug) => `${slug}-web`)
        .toSorted()
    )
  })
})

describe('redirectStubHtml', () => {
  it("should send a launch to the app's origin with its query and fragment", () => {
    const landed = followStub(
      'plots',
      'https://wildflowerhealth.io/health-viewer/?iss=https%3A%2F%2Fruth.example&launch=n1#x'
    )

    expect(landed).toBe(
      'https://plots.wildflowerhealth.io/?iss=https%3A%2F%2Fruth.example&launch=n1#x'
    )
  })

  it('should send a bare visit to the root of the app’s origin', () => {
    expect(followStub('strength', 'https://wildflowerhealth.io/lifting/')).toBe(
      'https://strength.wildflowerhealth.io/'
    )
  })

  it('should land a deep link the apex 404.html handed over on the same route of the app', () => {
    fc.assert(
      fc.property(appIdArb, routeArb, queryArb, (app, route, query) => {
        // Arrange — `404.html` sends `/<old>/<route>?<query>` to the stub at
        // `/<old>/`, with the path it was asked for in `?redirect=`.
        const oldPath = `/${APEX_REDIRECT_PATHS[app]}/`
        const params = new URLSearchParams(query)
        params.set('redirect', `${oldPath}${route}`)
        const handedOver = `https://wildflowerhealth.io${oldPath}?${params.toString()}`

        // Act — the stub redirects, then the app restores the route.
        const landed = new URL(followStub(app, handedOver) ?? '')
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
    const html = redirectStubHtml('/medications/', 'https://medications.wildflowerhealth.io/')

    expect(html).toContain('content="0; url=https://medications.wildflowerhealth.io/"')
    expect(html).toContain('<a href="https://medications.wildflowerhealth.io/">')
  })
})

// Helpers

const appIdArb = fc.constantFrom<HostedAppId>(...HOSTED_APP_IDS)

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

/** Run the stub `app`'s old path serves, as a browser would for `href`; where it sent the browser. */
const followStub = (app: HostedAppId, href: string): string | undefined => {
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
  const html = redirectStubHtml(`/${APEX_REDIRECT_PATHS[app]}/`, sectionUrl(app))
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
  // oxlint-disable-next-line typescript/no-implied-eval -- runs the generated stub's own script under test
  new Function('window', script)(window)
  return replacedWith
}
