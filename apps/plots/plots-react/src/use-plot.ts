import * as Plot from '@observablehq/plot'
import { type RefCallback, useLayoutEffect, useMemo, useState } from 'react'

/** A figure `Plot.plot` returned: the element, plus its `scale` / `legend` accessors. */
type PlotFigure = ReturnType<typeof Plot.plot>

/**
 * The width a figure renders at before its container has been measured — and
 * for good where nothing can measure it (jsdom has no layout and no
 * `ResizeObserver`). Plot's own default.
 */
const FALLBACK_WIDTH = 640

/** The element a figure mounts into, and the width it has to fill. */
interface PlotContainer {
  /**
   * Attach to the element the figure is mounted into; its width drives the
   * figure's. A callback ref, so a container that mounts after the hook (a
   * chart leaving its empty state) is still observed.
   */
  readonly containerRef: RefCallback<HTMLDivElement>
  /** The element `containerRef` is attached to, or `null` before it mounts. */
  readonly container: HTMLDivElement | null
  /** The width a figure in it renders at: the container's, once measured. */
  readonly width: number
}

/**
 * Measure the element a figure will mount into.
 *
 * @returns The ref to attach, the element once attached, and its width
 *
 * @remarks
 * Apart from {@link usePlot} so the width is known before the figure's options
 * are built: a chart whose marks depend on its width (how many buckets fit)
 * builds them from this width, and the figure is redrawn when it changes. The
 * width comes from a `ResizeObserver` on the container, so it follows the
 * layout rather than the window; where the observer does not exist it stays
 * {@link FALLBACK_WIDTH}.
 */
const usePlotContainer = (): PlotContainer => {
  const [container, containerRef] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(FALLBACK_WIDTH)

  useLayoutEffect(() => {
    if (container === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => {
      const measured = Math.floor(entry.contentRect.width)
      // A collapsed container (display: none, not yet laid out) reports 0; a
      // figure that narrow draws nothing useful, so keep the last good width.
      if (measured > 0) setWidth(measured)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [container])

  return { containerRef, container, width }
}

/**
 * Mount an Observable Plot figure into a measured container and keep it current.
 *
 * @param container - The element to mount into, from {@link usePlotContainer}
 * @param width - The width to draw at: that container's, from the same hook
 * @param options - The figure's options, `width` aside, or `null` to mount
 *   nothing. Memoise them: a new object replaces the figure.
 * @returns The figure currently mounted, for reading its scales, or `null`
 *   while `options` is `null`
 *
 * @remarks
 * Plot renders a detached element rather than into a node, so the hook owns
 * the swap: new options or a new container width build a new figure, which
 * replaces the old one in the container, and the effect's cleanup removes it
 * again on unmount.
 */
const usePlot = (
  container: HTMLDivElement | null,
  width: number,
  options: Plot.PlotOptions | null
): PlotFigure | null => {
  // Building the figure is pure — Plot returns a detached element — so it is
  // derived here; only attaching it to the container is an effect.
  const figure = useMemo(
    () => (options === null ? null : Plot.plot({ ...options, width })),
    [options, width]
  )

  useLayoutEffect(() => {
    if (container === null || figure === null) return undefined
    container.replaceChildren(figure)
    return () => figure.remove()
  }, [container, figure])

  return figure
}

export type { PlotContainer, PlotFigure }
export { FALLBACK_WIDTH, usePlot, usePlotContainer }
