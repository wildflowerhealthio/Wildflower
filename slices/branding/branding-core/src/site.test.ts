import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  APP_SLUGS,
  POLICY_IDS,
  POLICY_LABELS,
  POLICY_PATHS,
  SITE_ORIGIN,
  policyUrl,
  sectionUrl,
  sectionUrlIn,
  siteRootFor,
  type HostedAppId,
  type SectionId,
} from './site.ts'

const hostedAppIdArb = fc.constantFrom<HostedAppId>(
  'medications',
  'importer',
  'serverDocs',
  'ohifViewer',
  'fhirSyncPebble',
  'plots',
  'syntheticData',
  'strength',
  'watchLifts',
  'launcher',
  'authorization'
)

const sectionIdArb = fc.oneof(fc.constant<SectionId>('marketing'), hostedAppIdArb)

/** A path-segment-safe directory name, for a site root's own path. */
const directoryNameArb = fc.stringMatching(/^[a-z0-9-]{1,12}$/)

/** The root of a PR preview (or any assembled copy) that is not the published site. */
const previewRootArb = fc
  .tuple(
    fc.constantFrom('https://wildflowerhealthio.github.io', 'http://localhost:4173'),
    fc.array(directoryNameArb, { maxLength: 3 })
  )
  .map(([origin, directories]) => `${origin}/${directories.map((name) => `${name}/`).join('')}`)
  .filter((root) => root !== `${SITE_ORIGIN}/`)

describe('APP_SLUGS', () => {
  it('should name each hosted app by the subdomain its own origin is', () => {
    expect(APP_SLUGS).toStrictEqual({
      medications: 'medications',
      importer: 'importer',
      serverDocs: 'server-docs',
      ohifViewer: 'ohif-viewer',
      fhirSyncPebble: 'fhir-sync-pebble',
      plots: 'plots',
      syntheticData: 'synthetic-data',
      strength: 'strength',
      watchLifts: 'watch-lifts',
      launcher: 'launcher',
      authorization: 'authorization',
    })
  })

  it('should give every app a distinct slug that is a single DNS label', () => {
    const slugs = Object.values(APP_SLUGS)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  })
})

describe('sectionUrl', () => {
  it('should return the site origin with a trailing slash for marketing', () => {
    expect(sectionUrl('marketing')).toBe('https://wildflowerhealth.io/')
  })

  it("should return each hosted app's own origin", () => {
    expect(sectionUrl('medications')).toBe('https://medications.wildflowerhealth.io/')
    expect(sectionUrl('serverDocs')).toBe('https://server-docs.wildflowerhealth.io/')
    expect(sectionUrl('plots')).toBe('https://plots.wildflowerhealth.io/')
    expect(sectionUrl('launcher')).toBe('https://launcher.wildflowerhealth.io/')
  })

  it("should put every hosted app at the root of a subdomain of the site's", () => {
    fc.assert(
      fc.property(hostedAppIdArb, (id) => {
        const url = new URL(sectionUrl(id))
        expect(url.href).toBe(`https://${APP_SLUGS[id]}.wildflowerhealth.io/`)
        expect(url.origin).not.toBe(SITE_ORIGIN)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('sectionUrlIn', () => {
  it('should resolve to sectionUrl on the published site', () => {
    fc.assert(
      fc.property(sectionIdArb, (id) => {
        expect(sectionUrlIn(id, `${SITE_ORIGIN}/`)).toBe(sectionUrl(id))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it("should resolve a hosted app to its slug's directory under any other site root", () => {
    fc.assert(
      fc.property(hostedAppIdArb, previewRootArb, (id, siteRoot) => {
        expect(sectionUrlIn(id, siteRoot)).toBe(`${siteRoot}${APP_SLUGS[id]}/`)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should resolve marketing to the root of any other site copy', () => {
    fc.assert(
      fc.property(previewRootArb, (siteRoot) => {
        expect(sectionUrlIn('marketing', siteRoot)).toBe(siteRoot)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('siteRootFor', () => {
  it("should take a hosted app's slug off a URL serving it, under any origin and parent path", () => {
    fc.assert(
      fc.property(
        hostedAppIdArb,
        fc.constantFrom('https://wildflowerhealth.io', 'https://wildflowerhealthio.github.io'),
        fc.array(directoryNameArb, { maxLength: 3 }),
        fc.boolean(),
        (section, origin, parentDirectories, trailingSlash) => {
          // Arrange
          const siteRoot = `${origin}/${parentDirectories.map((name) => `${name}/`).join('')}`
          const sectionBaseUrl = `${siteRoot}${APP_SLUGS[section]}${trailingSlash ? '/' : ''}`

          // Act / Assert
          expect(siteRootFor(section, sectionBaseUrl)).toBe(siteRoot)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it("should resolve a PR preview's launcher to that preview's root", () => {
    expect(
      siteRootFor('launcher', 'https://wildflowerhealthio.github.io/staging/pr-7/launcher/')
    ).toBe('https://wildflowerhealthio.github.io/staging/pr-7/')
  })

  it('should resolve a hosted app on its own origin to the published site', () => {
    fc.assert(
      fc.property(hostedAppIdArb, (section) => {
        expect(siteRootFor(section, sectionUrl(section))).toBe(`${SITE_ORIGIN}/`)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should fall back to the published site for a URL that does not end in the slug', () => {
    fc.assert(
      fc.property(
        hostedAppIdArb,
        fc.constantFrom('http://localhost:5173', 'http://127.0.0.1:8080', SITE_ORIGIN),
        fc.array(directoryNameArb, { maxLength: 3 }),
        (section, origin, directories) => {
          // Arrange — a directory path whose last segment is never the section's.
          const path = directories.filter((name) => name !== APP_SLUGS[section])
          const sectionBaseUrl = `${origin}/${path.map((name) => `${name}/`).join('')}`

          // Act / Assert
          expect(siteRootFor(section, sectionBaseUrl)).toBe(`${SITE_ORIGIN}/`)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should resolve the marketing site to its own directory off the published origin', () => {
    fc.assert(
      fc.property(previewRootArb, (siteRoot) => {
        expect(siteRootFor('marketing', siteRoot)).toBe(siteRoot)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should resolve the marketing site on the published origin to the published site', () => {
    expect(siteRootFor('marketing', 'https://wildflowerhealth.io/')).toBe(`${SITE_ORIGIN}/`)
  })
})

describe('policyUrl', () => {
  it('should resolve each policy page to a slash-terminated URL on the canonical site', () => {
    expect(policyUrl('privacyPolicy')).toBe('https://wildflowerhealth.io/privacy-policy/')
    expect(policyUrl('consumerHealthData')).toBe(
      'https://wildflowerhealth.io/consumer-health-data/'
    )
    expect(policyUrl('terms')).toBe('https://wildflowerhealth.io/terms/')
    expect(policyUrl('deletion')).toBe('https://wildflowerhealth.io/deletion/')
  })

  it('should label every policy page', () => {
    expect(POLICY_IDS.toSorted()).toStrictEqual(Object.keys(POLICY_PATHS).toSorted())
    for (const id of POLICY_IDS) {
      expect(POLICY_LABELS[id].length).toBeGreaterThan(0)
    }
  })
})
