import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { APP_DESCRIPTIONS, APP_SECTION_IDS, type AppSectionId } from './app-descriptions.ts'
import { MARKETING_ANCHORS } from './nav.ts'
import { SECTION_PATHS } from './site.ts'

/**
 * Every described app: the homepage's SMART apps, and the owner UI, which has a
 * landing page but no homepage row.
 */
const DESCRIBED_APP_IDS: readonly AppSectionId[] = [...APP_SECTION_IDS, 'app']

const appSectionIdArb = fc.constantFrom<AppSectionId>(...DESCRIBED_APP_IDS)

describe('APP_SECTION_IDS', () => {
  it('should list every described app but the owner UI exactly once, and nothing else', () => {
    expect(DESCRIBED_APP_IDS.toSorted()).toStrictEqual(Object.keys(APP_DESCRIPTIONS).toSorted())
  })

  it('should only describe sections that exist in the deploy contract', () => {
    for (const id of DESCRIBED_APP_IDS) {
      expect(Object.keys(SECTION_PATHS)).toContain(id)
    }
  })
})

describe('APP_DESCRIPTIONS', () => {
  it('should give every app a name, a tagline, and at least one non-blank paragraph', () => {
    fc.assert(
      fc.property(appSectionIdArb, (id) => {
        const description = APP_DESCRIPTIONS[id]
        expect(description.name.trim()).not.toBe('')
        expect(description.tagline.trim()).not.toBe('')
        expect(description.paragraphs.length).toBeGreaterThan(0)
        for (const paragraph of description.paragraphs) {
          expect(paragraph.trim()).not.toBe('')
        }
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should point every app at an anchor the homepage renders', () => {
    fc.assert(
      fc.property(appSectionIdArb, (id) => {
        expect(MARKETING_ANCHORS).toContain(APP_DESCRIPTIONS[id].anchor)
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should name the app in its launch label, so the homepage link reads as a link into it', () => {
    fc.assert(
      fc.property(fc.constantFrom(...APP_SECTION_IDS), (id) => {
        const { name, launch } = APP_DESCRIPTIONS[id]
        expect(launch.label).toContain(name)
        expect(launch.label.endsWith('→')).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})
