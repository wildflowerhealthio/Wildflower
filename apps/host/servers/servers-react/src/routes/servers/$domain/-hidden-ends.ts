import { type RefObject, useLayoutEffect, useState } from 'react'

/** Which ends of a sideways-scrolling element have content scrolled out of sight past them. */
interface HiddenEnds {
  readonly before: boolean
  readonly after: boolean
}

/**
 * Reads which ends of `element` have content scrolled past them. A pixel of
 * slack at the far end absorbs the sub-pixel offset a zoomed page reports.
 */
const readHiddenEnds = (element: HTMLElement): HiddenEnds => ({
  before: element.scrollLeft > 0,
  after: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
})

/**
 * Which ends of the element `ref` holds have content scrolled past them,
 * read again as it scrolls and as it or its content resizes, so a fade can
 * mark each, as `RouteTabs` marks its strip's.
 */
const useHiddenEnds = (ref: RefObject<HTMLElement | null>): HiddenEnds => {
  const [hiddenEnds, setHiddenEnds] = useState<HiddenEnds>({ before: false, after: false })
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return undefined
    const measure = (): void => {
      const next = readHiddenEnds(element)
      setHiddenEnds((previous) =>
        previous.before === next.before && previous.after === next.after ? previous : next
      )
    }
    measure()
    element.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    return () => {
      element.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [ref])
  return hiddenEnds
}

export { useHiddenEnds, type HiddenEnds }
