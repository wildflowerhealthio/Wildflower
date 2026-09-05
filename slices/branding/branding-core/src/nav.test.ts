import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  HEADER_NAV_LINKS,
  MARKETING_ANCHORS,
  anchorHref,
  fromApp,
  navHref,
  onMarketingSite,
  sectionHref,
} from './nav.ts'
import { SECTION_PATHS, SITE_ORIGIN, sectionUrl } from './site.ts'

const anchorArb = fc.constantFrom(...MARKETING_ANCHORS)
const contextArb = fc.constantFrom(onMarketingSite, fromApp)

describe('anchorHref', () => {
  it('should produce fragment-only hrefs on the marketing site', () => {
    expect(anchorHref(onMarketingSite, 'built')).toBe('#built')
    expect(anchorHref(onMarketingSite, 'top')).toBe('#top')
  })

  it('should produce absolute hrefs from an app', () => {
    expect(anchorHref(fromApp, 'built')).toBe('https://wildflowerhealth.io/#built')
  })

  it('should always end with #<anchor>', () => {
    fc.assert(
      fc.property(contextArb, anchorArb, (ctx, anchor) => {
        expect(anchorHref(ctx, anchor)).toMatch(new RegExp(`#${anchor}$`))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should produce fragment-only hrefs in marketing context', () => {
    fc.assert(
      fc.property(anchorArb, (anchor) => {
        const href = anchorHref(onMarketingSite, anchor)
        expect(href.startsWith('#')).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should produce parseable absolute URLs in app context', () => {
    fc.assert(
      fc.property(anchorArb, (anchor) => {
        const href = anchorHref(fromApp, anchor)
        const url = new URL(href)
        expect(url.origin).toBe(SITE_ORIGIN)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('sectionHref', () => {
  it('should produce current-URL-relative paths on the marketing site', () => {
    expect(sectionHref(onMarketingSite, 'medications')).toBe('./medications-app')
    expect(sectionHref(onMarketingSite, 'serverDocs')).toBe('./wildflower-server-docs')
  })

  it('should produce absolute URLs from an app', () => {
    expect(sectionHref(fromApp, 'medications')).toBe('https://wildflowerhealth.io/medications-app')
  })

  it('should resolve relative-from-marketing under a preview sub-path to sibling builds', () => {
    // A `./medications-app` reference on `.../staging/pr-N/` resolves into
    // the same preview build, not the canonical origin — that is the whole
    // point of the marketing-context change.
    const previewBase = 'https://wildflowerhealth.io/staging/pr-607/'
    expect(new URL(sectionHref(onMarketingSite, 'medications'), previewBase).href).toBe(
      `${previewBase}medications-app`
    )
  })

  it('should match SECTION_PATHS on marketing and sectionUrl from an app', () => {
    const sectionArb = fc.constantFrom(
      ...(['medications', 'importer', 'webTrace', 'serverDocs'] as const)
    )
    fc.assert(
      fc.property(sectionArb, (section) => {
        expect(sectionHref(onMarketingSite, section)).toBe(`./${SECTION_PATHS[section]}`)
        expect(sectionHref(fromApp, section)).toBe(sectionUrl(section))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('navHref', () => {
  it('should resolve an anchor link like anchorHref', () => {
    expect(navHref({ kind: 'anchor', label: 'Top', anchor: 'top' }, onMarketingSite)).toBe('#top')
  })

  it('should pass an absolute link through unchanged', () => {
    const href = 'mailto:ruthmarks151@gmail.com'
    expect(navHref({ kind: 'absolute', label: 'Contact', href }, fromApp)).toBe(href)
  })

  it('should resolve a section link like sectionHref', () => {
    const link = { kind: 'section', label: 'Medications', section: 'medications' } as const
    expect(navHref(link, onMarketingSite)).toBe(sectionHref(onMarketingSite, 'medications'))
    expect(navHref(link, fromApp)).toBe(sectionHref(fromApp, 'medications'))
  })
})

describe('HEADER_NAV_LINKS', () => {
  it('should link directly into the four apps, in design order', () => {
    expect(HEADER_NAV_LINKS.map((link) => link.label)).toStrictEqual([
      'Medications',
      'Importer',
      'Web traces',
      'Server docs',
    ])
  })

  it('should be section links so the same bar resolves per context', () => {
    for (const link of HEADER_NAV_LINKS) {
      expect(link.kind).toBe('section')
    }
  })
})
