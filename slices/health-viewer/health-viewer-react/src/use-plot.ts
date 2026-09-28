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

/** What {@link usePlot} hands back to the component rendering the figure. */
interface MountedPlot {
  /**
   * Attach to the element the figure is mounted into; its width drives the
   * figure's. A callback ref, so a container that mounts after the hook (a
   * chart leaving its empty state) is still observed.
   */
  readonly containerRef: RefCallback<HTMLDivElement>
  /** The figure currently mounted, or `null` before the first mount and while `options` is `null`. */
  readonly figure: PlotFigure | null
  /** The width the figure is rendered at: the container's, once measured. */
  readonly width: number
}

/**
 * Mount an Observable Plot figure into a container and keep it current.
 *
 * @param options - The figure's options, `width` aside, or `null` to mount
 *   nothing. Memoise them: a new object replaces the figure.
 * @returns The container ref to attach, the mounted figure for reading its
 *   scales, and the width it was drawn at
 *
 * @remarks
 * Plot renders a detached element rather than into a node, so the hook owns
 * the swap: new options or a new container width build a new figure, which
 * replaces the old one in the container, and the effect's cleanup removes it
 * again on unmount. The width comes from a `ResizeObserver` on the container, so the
 * figure follows its layout rather than the window; where the observer does not
 * exist the figure keeps {@link FALLBACK_WIDTH}.
 */
const usePlot = (options: Plot.PlotOptions | null): MountedPlot => {
  const [container, containerRef] = useState<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(FALLBACK_WIDTH)

  useLayoutEffect(() => {
    if (container === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => {
      const measured = Math.floor(entry.contentRect.width)
      // A collapsed container (display: none, not yet laid out) reports 0; a
      // figure that narrow draws nothing useful, so keep the last good width.
      if (measured > 0) setContainerWidth(measured)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [container])

  // Building the figure is pure — Plot returns a detached element — so it is
  // derived here; only attaching it to the container is an effect.
  const figure = useMemo(
    () => (options === null ? null : Plot.plot({ ...options, width: containerWidth })),
    [options, containerWidth]
  )

  useLayoutEffect(() => {
    if (container === null || figure === null) return undefined
    container.replaceChildren(figure)
    return () => figure.remove()
  }, [container, figure])

  return { containerRef, figure, width: containerWidth }
}

export type { MountedPlot, PlotFigure }
export { FALLBACK_WIDTH, usePlot }
