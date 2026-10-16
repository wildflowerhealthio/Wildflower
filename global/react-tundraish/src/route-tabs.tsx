import { Link, Outlet, useLocation } from '@tanstack/react-router'
import type {
  AnyRouter,
  LinkComponentProps,
  RegisteredRouter,
  ValidateLinkOptionsArray,
} from '@tanstack/react-router'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'

import { readHiddenEnds, scrollToReveal } from './route-tabs-scroll.ts'
import type { HiddenEnds, StripScroll, TabSpan } from './route-tabs-scroll.ts'
import styles from './route-tabs.module.css'

/** What a tab shows: its label, beside the link options that say where it goes. */
interface RouteTabLabel {
  readonly label: string
}

interface RouteTabsProps<
  TRouter extends AnyRouter = RegisteredRouter,
  TTabs extends readonly RouteTabLabel[] = readonly RouteTabLabel[],
  TFrom extends string = string,
> {
  /**
   * One entry per tab, in strip order: the `<Link>` options of the child
   * route it opens (`to`, `params`, `search`…, type-checked against the
   * router like a `<Link>`'s), and its `label`. Labels are unique within a
   * strip.
   */
  readonly tabs: ValidateLinkOptionsArray<TRouter, TTabs, TFrom>
  /** Accessible name announced for the `<nav>` (e.g. "Server details"). */
  readonly 'aria-label': string
  /**
   * Size the shape to the component's own width instead of the viewport's:
   * the wide shape from this many pixels of it, the narrow one below.
   * Measured with a `ResizeObserver`, so the component needs a definite
   * width (a block in normal flow, a stretched flex or grid item); in a
   * shrink-to-fit parent its width would follow its own content.
   */
  readonly wideFromOwnWidth?: number
}

/** One tab as the strip renders it: a `<Link>`'s options and its label. */
type RouteTab = LinkComponentProps & RouteTabLabel

/** Which rule picks the shape: the viewport media query, or the measured own width. */
type RouteTabsShape = 'sized-by-viewport' | 'narrow' | 'wide'

const shapeClassNames: Record<RouteTabsShape, string | undefined> = {
  'sized-by-viewport': styles['route-tabs--sized-by-viewport'],
  narrow: undefined,
  wide: styles['route-tabs--wide'],
}

const NO_HIDDEN_ENDS: HiddenEnds = { before: false, after: false }

/**
 * Converts a computed `scroll-padding-inline-*` value to pixels. A computed
 * length is always in `px`, and the other computed value, `auto`, is no
 * padding.
 */
const pixelsOfScrollPadding = (computedLength: string): number =>
  computedLength.endsWith('px') ? Number.parseFloat(computedLength) : 0

/** Measures `strip`'s scroll offset, widths and scroll padding. */
const measureStripScroll = (strip: HTMLElement): StripScroll => {
  const stripStyle = getComputedStyle(strip)
  return {
    offset: strip.scrollLeft,
    viewportWidth: strip.clientWidth,
    contentWidth: strip.scrollWidth,
    paddingStart: pixelsOfScrollPadding(stripStyle.scrollPaddingInlineStart),
    paddingEnd: pixelsOfScrollPadding(stripStyle.scrollPaddingInlineEnd),
  }
}

/**
 * Measures where `tab` sits along `strip`'s scrollable content, from the
 * content's start edge (the strip's padding edge, where a zero offset puts
 * it), so the strip's own padding counts toward the tab's start.
 */
const measureTabSpan = (strip: HTMLElement, tab: HTMLElement): TabSpan => {
  const stripRect = strip.getBoundingClientRect()
  const tabRect = tab.getBoundingClientRect()
  const start = tabRect.left - stripRect.left - strip.clientLeft + strip.scrollLeft
  return { start, end: start + tabRect.width }
}

/**
 * Scrolls `strip` so its current tab (the link the router marks
 * `aria-current="page"`) sits clear of the end fades, moving it as little
 * as it can, and returns the ends left with tabs hidden past them.
 * Scrolling the strip itself, rather than calling `scrollIntoView`, never
 * moves the page around it.
 */
const scrollStripToCurrentTab = (strip: HTMLElement, behavior: ScrollBehavior): HiddenEnds => {
  const currentTab = strip.querySelector<HTMLElement>('[aria-current="page"]')
  if (currentTab !== null) {
    const revealedScroll = scrollToReveal(
      measureStripScroll(strip),
      measureTabSpan(strip, currentTab)
    )
    strip.scrollTo({ left: revealedScroll.offset, behavior })
  }
  // Mid-way through a smooth scroll this reads where it starts; the
  // strip's scroll events re-read the ends as it moves.
  return readHiddenEnds(measureStripScroll(strip))
}

const prefersReducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Picks the shape: `'sized-by-viewport'` without a `wideFromOwnWidth`,
 * leaving it to the CSS media query; otherwise `'wide'` or `'narrow'` from
 * `root`'s width, re-measured on every resize. The first measurement runs
 * before paint, so the first frame has the measured shape.
 */
const useRouteTabsShape = (
  root: { readonly current: HTMLElement | null },
  wideFromOwnWidth: number | undefined
): RouteTabsShape => {
  const [isWide, setIsWide] = useState(false)
  useLayoutEffect(() => {
    const rootElement = root.current
    if (wideFromOwnWidth === undefined || rootElement === null) {
      return undefined
    }
    const measure = (): void => {
      setIsWide(rootElement.getBoundingClientRect().width >= wideFromOwnWidth)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(rootElement)
    return () => {
      observer.disconnect()
    }
  }, [root, wideFromOwnWidth])
  if (wideFromOwnWidth === undefined) {
    return 'sized-by-viewport'
  }
  return isWide ? 'wide' : 'narrow'
}

/**
 * A tab strip over the router's child routes. Each tab is a TanStack
 * `<Link>` to a child route of the caller's route, navigating with
 * `replace` so Back leaves the page rather than stepping back through its
 * tabs. The caller's route renders `<RouteTabs>` in its component, and the
 * panel under the strip is an `<Outlet />` the open child route fills. The
 * router decides which tab is current, through each `<Link>`'s active
 * state.
 *
 * A route with tabs opens on its first one by redirecting its index route
 * there, with `replace` so the bare path doesn't stay in history:
 *
 * ```ts
 * createRoute({
 *   getParentRoute: () => serverRoute,
 *   path: '/',
 *   beforeLoad: ({ params }) => {
 *     throw redirect({ to: '/servers/$id/status', params, replace: true })
 *   },
 * })
 * ```
 *
 * The strip is a `<nav>` of links with the current one `aria-current="page"`:
 * these are navigation, not a `role="tablist"`, so Tab moves between them
 * and there is no arrow-key handling. For a one-of-N choice that isn't
 * navigation, reach for `SegmentedToggle`.
 *
 * From a 768px-wide viewport it is a pill track sized to its labels above an
 * unframed panel. Below that it is the top edge of a card holding the panel,
 * the strip running the card's full width. `wideFromOwnWidth` switches on
 * the component's own width instead. In both shapes the current tab is a
 * raised neutral chip in the panel's surface colour, and a strip whose tabs
 * don't fit scrolls sideways (no visible scrollbar, a fade on each end with
 * tabs past it), keeping the current tab clear of the fades as it changes
 * and as the strip resizes.
 */
function RouteTabs<
  TRouter extends AnyRouter = RegisteredRouter,
  const TTabs extends readonly RouteTabLabel[] = readonly RouteTabLabel[],
  TFrom extends string = string,
>(props: RouteTabsProps<TRouter, TTabs, TFrom>): JSX.Element
function RouteTabs({
  tabs,
  'aria-label': ariaLabel,
  wideFromOwnWidth,
}: {
  readonly tabs: readonly RouteTab[]
  readonly 'aria-label': string
  readonly wideFromOwnWidth?: number
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const [hiddenEnds, setHiddenEnds] = useState<HiddenEnds>(NO_HIDDEN_ENDS)
  const shape = useRouteTabsShape(rootRef, wideFromOwnWidth)
  // Subscribing to the location re-renders this component on every
  // navigation, which a child route change otherwise needn't do, so the
  // effect below sees each new current tab.
  const locationHref = useLocation({ select: (location) => location.href })
  /** The location the strip last scrolled its current tab into view for. */
  const scrolledForHrefRef = useRef<string | null>(null)

  // Bring the current tab into view as the location changes: at once on the
  // first render, smoothly after (at once for reduced motion). A layout
  // effect, so the first frame is already scrolled.
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (strip === null) {
      return
    }
    const behavior =
      scrolledForHrefRef.current !== null && !prefersReducedMotion() ? 'smooth' : 'instant'
    scrolledForHrefRef.current = locationHref
    setHiddenEnds(scrollStripToCurrentTab(strip, behavior))
  }, [locationHref])

  // Re-reveal the current tab whenever the strip or its row of tabs
  // resizes: a narrowing strip, a web font landing, or relabelled tabs can
  // each move it out of view.
  useEffect(() => {
    const strip = stripRef.current
    const row = rowRef.current
    if (strip === null || row === null) {
      return undefined
    }
    const observer = new ResizeObserver(() => {
      setHiddenEnds(scrollStripToCurrentTab(strip, 'instant'))
    })
    observer.observe(strip)
    observer.observe(row)
    return () => {
      observer.disconnect()
    }
  }, [])

  return (
    <div ref={rootRef} className={cn(styles['route-tabs'], shapeClassNames[shape])}>
      <nav
        ref={stripRef}
        className={cn(
          styles['route-tabs__strip'],
          hiddenEnds.before ? styles['route-tabs__strip--hidden-before'] : null,
          hiddenEnds.after ? styles['route-tabs__strip--hidden-after'] : null
        )}
        aria-label={ariaLabel}
        onScroll={(event) => {
          setHiddenEnds(readHiddenEnds(measureStripScroll(event.currentTarget)))
        }}
      >
        <div ref={rowRef} className={styles['route-tabs__row']}>
          {tabs.map(({ label, ...linkOptions }) => (
            <Link key={label} {...linkOptions} replace className={styles['route-tabs__tab']}>
              {label}
            </Link>
          ))}
        </div>
      </nav>
      <div className={styles['route-tabs__panel']}>
        <Outlet />
      </div>
    </div>
  )
}

export { RouteTabs, type RouteTabLabel, type RouteTabsProps }
