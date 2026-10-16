/**
 * The geometry of a `RouteTabs` strip that scrolls sideways, as plain
 * numbers in pixels along the scroll axis, so the scroll maths can be
 * checked without a layout engine.
 */

/** A scrolling strip: where it is scrolled to, and the widths that bound it. */
interface StripScroll {
  /** How far the content is scrolled past the strip's start edge (`scrollLeft`). */
  readonly offset: number
  /** The visible width (`clientWidth`). */
  readonly viewportWidth: number
  /** The width of everything it scrolls over, its own padding included (`scrollWidth`). */
  readonly contentWidth: number
  /** The strip's `scroll-padding-inline-start`: how far in from the start a revealed tab stays. */
  readonly paddingStart: number
  /** The strip's `scroll-padding-inline-end`. */
  readonly paddingEnd: number
}

/** Where a tab sits along the strip's content, from the content's start edge. */
interface TabSpan {
  readonly start: number
  readonly end: number
}

/** Which ends of the strip have tabs scrolled out of sight past them. */
interface HiddenEnds {
  readonly before: boolean
  readonly after: boolean
}

/**
 * Scrolls `strip` so `tab` lies inside its scroll padding, moving it as
 * little as it can, and no further than either end of its content. A tab
 * already inside the padding leaves the strip where it is.
 */
const scrollToReveal = (strip: StripScroll, tab: TabSpan): StripScroll => {
  const maxOffset = Math.max(strip.contentWidth - strip.viewportWidth, 0)
  const scrollWithinContent = (offset: number): StripScroll => ({
    ...strip,
    offset: Math.min(Math.max(offset, 0), maxOffset),
  })
  if (tab.start < strip.offset + strip.paddingStart) {
    return scrollWithinContent(tab.start - strip.paddingStart)
  }
  if (tab.end > strip.offset + strip.viewportWidth - strip.paddingEnd) {
    return scrollWithinContent(tab.end + strip.paddingEnd - strip.viewportWidth)
  }
  return strip
}

/**
 * Reads which ends of `strip` have content scrolled past them. A pixel of
 * slack at the far end absorbs the sub-pixel offset a zoomed page reports.
 */
const readHiddenEnds = (strip: StripScroll): HiddenEnds => ({
  before: strip.offset > 0,
  after: strip.offset + strip.viewportWidth < strip.contentWidth - 1,
})

export { readHiddenEnds, scrollToReveal, type HiddenEnds, type StripScroll, type TabSpan }
