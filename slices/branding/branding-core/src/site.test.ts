import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  SECTION_PATHS,
  SITE_ORIGIN,
  sectionRootPath,
  sectionUrl,
  siteRootFor,
  type SectionId,
} from './site.ts'

const sectionIdArb = fc.constantFrom<SectionId>(
  'marketing',
  'medications',
  'importer',
  'serverDocs',
  'ohifViewer',
  'fhirSyncPebble',
  'healthViewer',
  'syntheticData',
  'lifting',
  'watchLifts',
  'launcher'
)

describe('SECTION_PATHS', () => {
  it('should contain exactly ten sections with the correct deploy-contract paths', () => {
    expect(SECTION_PATHS).toStrictEqual({
      marketing: '',
      medications: 'medications',
      importer: 'importer',
      serverDocs: 'server-docs',
      ohifViewer: 'ohif-viewer',
      fhirSyncPebble: 'fhir-sync-pebble',
      healthViewer: 'health-viewer',
      syntheticData: 'synthetic-data',
      lifting: 'lifting',
      watchLifts: 'watch-lifts',
      launcher: 'launcher',
    })
  })
})

describe('sectionUrl', () => {
  it('should return the site origin with a trailing slash for marketing', () => {
    expect(sectionUrl('marketing')).toBe('https://wildflowerhealth.io/')
  })

  it('should return absolute URLs for non-marketing sections', () => {
    expect(sectionUrl('medications')).toBe('https://wildflowerhealth.io/medications')
    expect(sectionUrl('serverDocs')).toBe('https://wildflowerhealth.io/server-docs')
    expect(sectionUrl('launcher')).toBe('https://wildflowerhealth.io/launcher')
  })

  it('should always start with SITE_ORIGIN/', () => {
    fc.assert(
      fc.property(sectionIdArb, (id) => {
        expect(sectionUrl(id).startsWith(`${SITE_ORIGIN}/`)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never contain a double slash after the origin', () => {
    fc.assert(
      fc.property(sectionIdArb, (id) => {
        const afterOrigin = sectionUrl(id).slice(SITE_ORIGIN.length)
        expect(afterOrigin).not.toContain('//')
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should end with the section path', () => {
    fc.assert(
      fc.property(sectionIdArb, (id) => {
        const path = SECTION_PATHS[id]
        const url = sectionUrl(id)
        if (path === '') {
          expect(url).toBe(`${SITE_ORIGIN}/`)
        } else {
          expect(url.endsWith(path)).toBe(true)
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('sectionRootPath', () => {
  it('should return "/" for marketing', () => {
    expect(sectionRootPath('marketing')).toBe('/')
  })

  it('should always start with "/"', () => {
    fc.assert(
      fc.property(sectionIdArb, (id) => {
        expect(sectionRootPath(id)).toMatch(/^\//)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should resolve to the same absolute URL as sectionUrl when joined with SITE_ORIGIN', () => {
    fc.assert(
      fc.property(sectionIdArb, (id) => {
        const fromRootPath = new URL(sectionRootPath(id), SITE_ORIGIN).href
        expect(fromRootPath).toBe(sectionUrl(id))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

/** A section other than the site root itself: what {@link siteRootFor} takes. */
const subsectionIdArb = sectionIdArb.filter(
  (id): id is Exclude<SectionId, 'marketing'> => id !== 'marketing'
)

/** A path-segment-safe directory name, for a site root's own path. */
const directoryNameArb = fc.stringMatching(/^[a-z0-9-]{1,12}$/)

describe('siteRootFor', () => {
  it("should take the section's own path off a URL serving it, under any origin and parent path", () => {
    fc.assert(
      fc.property(
        subsectionIdArb,
        fc.constantFrom('https://wildflowerhealth.io', 'https://wildflowerhealthio.github.io'),
        fc.array(directoryNameArb, { maxLength: 3 }),
        fc.boolean(),
        (section, origin, parentDirectories, trailingSlash) => {
          // Arrange
          const siteRoot = `${origin}/${parentDirectories.map((name) => `${name}/`).join('')}`
          const sectionBaseUrl = `${siteRoot}${SECTION_PATHS[section]}${trailingSlash ? '/' : ''}`

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

  it('should fall back to the canonical site for a URL that does not end in the section path', () => {
    fc.assert(
      fc.property(
        subsectionIdArb,
        fc.constantFrom('http://localhost:5173', 'http://127.0.0.1:8080', SITE_ORIGIN),
        fc.array(directoryNameArb, { maxLength: 3 }),
        (section, origin, directories) => {
          // Arrange — a directory path whose last segment is never the section's.
          const path = directories.filter((name) => name !== SECTION_PATHS[section])
          const sectionBaseUrl = `${origin}/${path.map((name) => `${name}/`).join('')}`

          // Act / Assert
          expect(siteRootFor(section, sectionBaseUrl)).toBe(`${SITE_ORIGIN}/`)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
