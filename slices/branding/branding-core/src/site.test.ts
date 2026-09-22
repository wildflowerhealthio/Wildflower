import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { SECTION_PATHS, SITE_ORIGIN, sectionRootPath, sectionUrl, type SectionId } from './site.ts'

const sectionIdArb = fc.constantFrom<SectionId>(
  'marketing',
  'medications',
  'importer',
  'webTrace',
  'serverDocs',
  'ohifViewer',
  'app'
)

describe('SECTION_PATHS', () => {
  it('should contain exactly seven sections with the correct deploy-contract paths', () => {
    expect(SECTION_PATHS).toStrictEqual({
      marketing: '',
      medications: 'medications-app',
      importer: 'importer-app',
      webTrace: 'web-trace-app',
      serverDocs: 'wildflower-server-docs',
      ohifViewer: 'ohif-viewer',
      app: 'app',
    })
  })
})

describe('sectionUrl', () => {
  it('should return the site origin with a trailing slash for marketing', () => {
    expect(sectionUrl('marketing')).toBe('https://wildflowerhealth.io/')
  })

  it('should return absolute URLs for non-marketing sections', () => {
    expect(sectionUrl('medications')).toBe('https://wildflowerhealth.io/medications-app')
    expect(sectionUrl('serverDocs')).toBe('https://wildflowerhealth.io/wildflower-server-docs')
    expect(sectionUrl('app')).toBe('https://wildflowerhealth.io/app')
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
