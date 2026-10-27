import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  HEADER_NAV_GROUPS,
  MARKETING_ANCHORS,
  anchorHref,
  fromApp,
  navHref,
  onMarketingSite,
} from './nav.ts'
import { SITE_ORIGIN, sectionUrl } from './site.ts'

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

describe('navHref', () => {
  it('should resolve an anchor link like anchorHref', () => {
    expect(navHref({ kind: 'anchor', label: 'Top', anchor: 'top' }, onMarketingSite)).toBe('#top')
  })

  it('should pass an absolute link through unchanged', () => {
    const href = 'mailto:ruthmarks151@gmail.com'
    expect(navHref({ kind: 'absolute', label: 'Contact', href }, fromApp)).toBe(href)
  })

  it("should resolve a section link to the section's published URL from every context", () => {
    const sectionArb = fc.constantFrom(
      ...(['medications', 'importer', 'serverDocs', 'ohifViewer', 'plots', 'strength'] as const)
    )
    fc.assert(
      fc.property(contextArb, sectionArb, (ctx, section) => {
        const link = { kind: 'section', label: 'App', section } as const
        expect(navHref(link, ctx)).toBe(sectionUrl(section))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('HEADER_NAV_GROUPS', () => {
  it('should group the apps under their menu headings, in design order', () => {
    expect(
      HEADER_NAV_GROUPS.map((group) => [group.label, group.links.map((link) => link.label)])
    ).toStrictEqual([
      ['Your health', ['Wildflower Medications', 'Wildflower Plots', 'Wildflower Imaging']],
      ['Your data', ['Wildflower Importer', 'Wildflower Launcher', 'Wildflower Authorization']],
      ['Fitness', ['FHIR Sync for Pebble', 'WatchLifts', 'Wildflower Strength']],
      [
        'Developer',
        ['Wildflower App Catalog', 'Wildflower Server Docs', 'Wildflower Synthetic Data Loader'],
      ],
    ])
  })

  it('should be section links, so every bar links the published apps', () => {
    for (const link of HEADER_NAV_GROUPS.flatMap((group) => group.links)) {
      expect(link.kind).toBe('section')
    }
  })
})
