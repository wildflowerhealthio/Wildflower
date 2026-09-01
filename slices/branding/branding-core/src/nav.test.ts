import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  FOOTER_COMPANY_LINKS,
  FOOTER_PRODUCT_LINKS,
  HEADER_NAV_LINKS,
  MARKETING_ANCHORS,
  anchorHref,
  fromApp,
  onMarketingSite,
} from './nav.ts'
import { SITE_ORIGIN, sectionUrl } from './site.ts'

const anchorArb = fc.constantFrom(...MARKETING_ANCHORS)
const contextArb = fc.constantFrom(onMarketingSite, fromApp)

describe('anchorHref', () => {
  it('should produce fragment-only hrefs on the marketing site', () => {
    expect(anchorHref(onMarketingSite, 'how')).toBe('#how')
    expect(anchorHref(onMarketingSite, 'top')).toBe('#top')
  })

  it('should produce absolute hrefs from an app', () => {
    expect(anchorHref(fromApp, 'how')).toBe('https://wildflowerhealth.io/#how')
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

describe('HEADER_NAV_LINKS', () => {
  it('should contain three links: The apps, Privacy, Request invite', () => {
    const labels = HEADER_NAV_LINKS.map((l) => l.label)
    expect(labels).toStrictEqual(['The apps', 'Privacy', 'Request invite'])
  })

  it('should mark only Request invite as a CTA', () => {
    for (const link of HEADER_NAV_LINKS) {
      if (link.kind === 'anchor') {
        if (link.label === 'Request invite') {
          expect(link.cta).toBe(true)
        } else {
          expect(link.cta).toBeUndefined()
        }
      }
    }
  })
})

describe('FOOTER_PRODUCT_LINKS', () => {
  it('should include the Server API docs absolute URL', () => {
    const serverDocsLink = FOOTER_PRODUCT_LINKS.find((l) => l.label === 'Server API docs')
    expect(serverDocsLink).toBeDefined()
    expect(serverDocsLink!.kind).toBe('absolute')
    if (serverDocsLink!.kind === 'absolute') {
      expect(serverDocsLink!.href).toBe(sectionUrl('serverDocs'))
    }
  })
})

describe('FOOTER_COMPANY_LINKS', () => {
  it('should include About and Contact', () => {
    const labels = FOOTER_COMPANY_LINKS.map((l) => l.label)
    expect(labels).toStrictEqual(['About', 'Contact'])
  })

  it('should have Contact as a mailto link', () => {
    const contact = FOOTER_COMPANY_LINKS.find((l) => l.label === 'Contact')
    expect(contact).toBeDefined()
    expect(contact!.kind).toBe('absolute')
    if (contact!.kind === 'absolute') {
      expect(contact!.href).toMatch(/^mailto:/)
    }
  })
})
