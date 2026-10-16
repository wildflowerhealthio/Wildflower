import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { readHiddenEnds, scrollToReveal } from './route-tabs-scroll.ts'
import type { StripScroll, TabSpan } from './route-tabs-scroll.ts'

/**
 * A strip laid out the way the stylesheet lays one out: `padding` on each
 * side of a row of tabs `gap` apart, scroll padding equal to the `fade`
 * width on both ends, and a fade no narrower than the padding. The viewport
 * holds the widest tab with a fade on both sides, and the strip starts at
 * any offset its content allows.
 */
interface StripLayout {
  readonly fade: number
  readonly tabs: readonly TabSpan[]
  readonly strip: StripScroll
}

const arbitraryStripLayout: fc.Arbitrary<StripLayout> = fc
  .record({
    fade: fc.integer({ min: 0, max: 48 }),
    paddingShare: fc.double({ min: 0, max: 1, noNaN: true }),
    gap: fc.integer({ min: 0, max: 16 }),
    tabWidths: fc.array(fc.integer({ min: 1, max: 200 }), { minLength: 1, maxLength: 12 }),
    extraViewport: fc.integer({ min: 0, max: 600 }),
    offsetShare: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(({ fade, paddingShare, gap, tabWidths, extraViewport, offsetShare }) => {
    const padding = Math.floor(fade * paddingShare)
    const tabs = tabWidths.reduce<TabSpan[]>((laidOut, width) => {
      const start = laidOut.length === 0 ? padding : (laidOut.at(-1)?.end ?? 0) + gap
      return [...laidOut, { start, end: start + width }]
    }, [])
    const contentWidth = (tabs.at(-1)?.end ?? 0) + padding
    const viewportWidth = Math.max(...tabWidths) + 2 * fade + extraViewport
    const maxOffset = Math.max(contentWidth - viewportWidth, 0)
    return {
      fade,
      tabs,
      strip: {
        offset: Math.round(maxOffset * offsetShare),
        viewportWidth,
        contentWidth,
        paddingStart: fade,
        paddingEnd: fade,
      },
    }
  })

const arbitraryLayoutAndTab = arbitraryStripLayout.chain((layout) =>
  fc.nat({ max: layout.tabs.length - 1 }).map((tabIndex) => ({ layout, tabIndex }))
)

/** The stretch of content the strip shows unfaded at its offset, with a fade on each end hiding tabs. */
const unfadedSpan = (strip: StripScroll, fade: number): TabSpan => {
  const hiddenEnds = readHiddenEnds(strip)
  return {
    start: strip.offset + (hiddenEnds.before ? fade : 0),
    end: strip.offset + strip.viewportWidth - (hiddenEnds.after ? fade : 0),
  }
}

describe('scrollToReveal', () => {
  it('leaves the tab inside the unfaded part of the strip, within the scrollable range', () => {
    fc.assert(
      fc.property(arbitraryLayoutAndTab, ({ layout, tabIndex }) => {
        // Arrange
        const tab = layout.tabs[tabIndex]
        if (tab === undefined) {
          throw new Error('tabIndex is drawn from the tabs')
        }

        // Act
        const revealed = scrollToReveal(layout.strip, tab)

        // Assert
        const unfaded = unfadedSpan(revealed, layout.fade)
        expect(tab.start).toBeGreaterThanOrEqual(unfaded.start)
        expect(tab.end).toBeLessThanOrEqual(unfaded.end)
        expect(revealed.offset).toBeGreaterThanOrEqual(0)
        expect(revealed.offset).toBeLessThanOrEqual(
          Math.max(layout.strip.contentWidth - layout.strip.viewportWidth, 0)
        )
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('scrolls all the way back to the start to reveal the first tab', () => {
    fc.assert(
      fc.property(arbitraryStripLayout, (layout) => {
        // Arrange
        const [firstTab] = layout.tabs
        if (firstTab === undefined) {
          throw new Error('a layout has at least one tab')
        }

        // Act
        const revealed = scrollToReveal(layout.strip, firstTab)

        // Assert
        expect(revealed.offset).toBe(0)
        expect(readHiddenEnds(revealed).before).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('leaves the strip where it is when the tab is already inside its scroll padding', () => {
    fc.assert(
      fc.property(arbitraryLayoutAndTab, ({ layout, tabIndex }) => {
        // Arrange
        const tab = layout.tabs[tabIndex]
        if (tab === undefined) {
          throw new Error('tabIndex is drawn from the tabs')
        }
        const { strip } = layout
        fc.pre(
          tab.start >= strip.offset + strip.paddingStart &&
            tab.end <= strip.offset + strip.viewportWidth - strip.paddingEnd
        )

        // Act / Assert
        expect(scrollToReveal(strip, tab)).toEqual(strip)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
