import { Link } from '@tanstack/react-router'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'

import styles from './route-tabs.module.css'

/** One tab in a {@link RouteTabs} strip: the `tab` search value it sets, and its label. */
interface RouteTab<T extends string> {
  readonly id: T
  readonly label: string
}

interface RouteTabsProps<T extends string> {
  /** The open tab, as the caller's route reads it from its `tab` search param. */
  readonly current: T
  readonly tabs: readonly RouteTab<T>[]
  /** Accessible name announced for the `<nav>` (e.g. "Server details"). */
  readonly 'aria-label': string
  /** The open tab's panel, drawn under the strip. */
  readonly children: ReactNode
}

/** Which ends of the strip have tabs scrolled out of sight past them. */
interface HiddenTabs {
  readonly before: boolean
  readonly after: boolean
}

const NO_HIDDEN_TABS: HiddenTabs = { before: false, after: false }

/** Reads which ends of `strip` have tabs scrolled out past them. */
const hiddenTabsOf = (strip: HTMLElement): HiddenTabs => ({
  before: strip.scrollLeft > 0,
  // A pixel of slack absorbs the sub-pixel `scrollLeft` a zoomed page reports.
  after: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1,
})

/**
 * The `scrollLeft` that brings `tab` fully into view inside `strip`, moving
 * the strip as little as it can; the current `scrollLeft` when the tab is
 * already in view. The strip is the tab's offset parent, so `offsetLeft` is
 * measured from the strip's scrolled content edge.
 */
const scrollLeftRevealing = (strip: HTMLElement, tab: HTMLElement): number => {
  const tabEnd = tab.offsetLeft + tab.offsetWidth
  if (tab.offsetLeft < strip.scrollLeft) {
    return tab.offsetLeft
  }
  if (tabEnd > strip.scrollLeft + strip.clientWidth) {
    return tabEnd - strip.clientWidth
  }
  return strip.scrollLeft
}

/**
 * A route-linked tab strip above the caller's panel. Each tab is a TanStack
 * `<Link>` to the current route with its `tab` search param set (the route's
 * other search params kept), navigating with `replace` so Back leaves the
 * page rather than stepping back through its tabs. The caller reads `tab` in
 * its route's `validateSearch`, passes it as `current`, and renders that
 * tab's panel as `children`.
 *
 * The strip is a `<nav>` of links with the current one `aria-current="page"`:
 * these are navigation, not a `role="tablist"`, so Tab moves between them
 * and there is no arrow-key handling. For a one-of-N choice that isn't
 * navigation, reach for `SegmentedToggle`.
 *
 * The shape follows the component's own width, through a container query.
 * From 560px it is a pill track sized to its labels above an unframed panel.
 * Below that it is the top edge of a card holding the panel, the strip
 * running the card's full width. In both shapes the current tab is a raised
 * neutral chip in the panel's surface colour, and a strip whose tabs don't
 * fit scrolls sideways (no visible scrollbar, snapping to tabs, a fade on
 * each end with tabs past it) and keeps the current tab scrolled into view.
 */
const RouteTabs = <T extends string>({
  current,
  tabs,
  'aria-label': ariaLabel,
  children,
}: RouteTabsProps<T>): JSX.Element => {
  const stripRef = useRef<HTMLElement>(null)
  const [hiddenTabs, setHiddenTabs] = useState<HiddenTabs>(NO_HIDDEN_TABS)

  // Re-read the faded ends whenever the strip's width changes: a container
  // that widens past its tabs drops the fade, one that narrows gains it.
  useEffect(() => {
    const strip = stripRef.current
    if (strip === null) {
      return undefined
    }
    const observer = new ResizeObserver(() => {
      setHiddenTabs(hiddenTabsOf(strip))
    })
    observer.observe(strip)
    return () => {
      observer.disconnect()
    }
  }, [])

  const currentIndex = tabs.findIndex((tab) => tab.id === current)
  useEffect(() => {
    const strip = stripRef.current
    const currentTab = strip?.children.item(currentIndex)
    if (strip === null || !(currentTab instanceof HTMLElement)) {
      return
    }
    // Setting `scrollLeft` rather than calling `scrollIntoView` moves only
    // the strip, never the page around it.
    strip.scrollLeft = scrollLeftRevealing(strip, currentTab)
    setHiddenTabs(hiddenTabsOf(strip))
  }, [currentIndex])

  return (
    <div className={styles['route-tabs']}>
      <div className={styles['route-tabs__frame']}>
        <nav
          ref={stripRef}
          className={cn(
            styles['route-tabs__strip'],
            hiddenTabs.before ? styles['route-tabs__strip--hidden-before'] : null,
            hiddenTabs.after ? styles['route-tabs__strip--hidden-after'] : null
          )}
          aria-label={ariaLabel}
          onScroll={(event) => {
            setHiddenTabs(hiddenTabsOf(event.currentTarget))
          }}
        >
          {tabs.map((tab) => (
            <Link
              key={tab.id}
              to="."
              search={(previous: Readonly<Record<string, unknown>>) => ({
                ...previous,
                tab: tab.id,
              })}
              replace
              className={styles['route-tabs__tab']}
              aria-current={tab.id === current ? 'page' : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <div className={styles['route-tabs__panel']}>{children}</div>
      </div>
    </div>
  )
}

export { RouteTabs, type RouteTab, type RouteTabsProps }
