import { DateTime } from 'effect'
import { type JSX, type PointerEvent, useCallback, useEffect, useMemo, useState } from 'react'

import { ColourSlots, Crosshair, type TimeDomain, type ValueAxis } from 'health-viewer-fundamentals'

import { FRAME_HEIGHT, MARGIN_TOP, chartOptions } from './chart-marks.ts'
import { CrosshairTooltip } from './crosshair-tooltip.tsx'
import { Legend } from './legend.tsx'
import { usePlot } from './use-plot.ts'
import styles from './multi-axis-chart.module.css'

interface MultiAxisChartProps {
  /**
   * The value axes `ValueAxis.assign` produced, in selection order. A series
   * keeps its colour for as long as it stays selected, so removing one never
   * repaints the others; a newcomer takes the lowest colour left free.
   */
  readonly axes: readonly ValueAxis.ValueAxis[]
  /** The time window the x axis spans. */
  readonly xDomain: TimeDomain.TimeDomain
  /** Told the instant the crosshair moves to, and `null` when it leaves the figure. */
  readonly onHover?: ((time: DateTime.Utc | null) => void) | undefined
}

/** Room the tooltip needs beside the crosshair: its CSS `max-width` plus its `--space-5` gap from the rule. */
const TOOLTIP_ROOM = 280 + 12

/**
 * Each axis' palette index, parallel to `axes`: `ColourSlots.assign`, carried
 * from one render to the next so a survivor keeps its colour.
 *
 * @remarks
 * Derived state rather than an effect: when the selection changes the new
 * assignment is stored during render, so the first paint already wears it.
 */
const useColours = (axes: readonly ValueAxis.ValueAxis[]): readonly number[] => {
  const ids = axes.map((axis) => axis.series.id)
  const [kept, setKept] = useState<ColourSlots.ColourSlots>(() =>
    ColourSlots.assign(new Map(), ids)
  )
  const current = ColourSlots.assign(kept, ids)
  if (current !== kept) setKept(current)
  // `current` is the stored assignment itself while the selection holds, so
  // the figure is not rebuilt for an unchanged one.
  return useMemo(() => axes.map((axis) => current.get(axis.series.id) ?? 0), [axes, current])
}

/**
 * The health viewer's chart: every selected series on one time axis, each
 * against its own colour-matched value axis — two on the left, two on the
 * right — with each series' `low` / `high` band shaded behind the lines and a
 * crosshair that reads every series at the pointer's time.
 *
 * @remarks
 * Deliberately a multi-axis overlay, the one recorded exception to the
 * dataviz guidance: the viewer exists to read one series against another it
 * is meant to move. Every series is drawn on a shared `0..1` scale through its
 * axis' domain, and each axis maps that scale back to the series' values —
 * the domains and ticks are `ValueAxis.assign`'s, not re-derived here.
 *
 * The crosshair snaps to the nearest `Crosshair.stops` boundary — a reading,
 * or a level starting or ending — across all series, and lists the level each
 * series holds there (`Series.levelAt`), so the pointer never has to land on
 * a line. The whole plot is the hit area.
 */
const MultiAxisChart = ({ axes, xDomain, onHover }: MultiAxisChartProps): JSX.Element => {
  const stops = useMemo(
    () =>
      Crosshair.stops(
        axes.map((axis) => axis.series),
        xDomain
      ),
    [axes, xDomain]
  )
  const [hover, setHover] = useState<{
    readonly stops: readonly number[]
    readonly millis: number
  } | null>(null)
  // A hover belongs to the stops it snapped to. New axes or a new window (a
  // range change, a back navigation, the chart leaving its empty state) drop it
  // rather than leave a crosshair where the pointer never was.
  const hoverIsStale = hover !== null && hover.stops !== stops
  const hoveredMillis = hover === null || hoverIsStale ? null : hover.millis
  useEffect(() => {
    if (hoverIsStale) onHover?.(null)
  }, [hoverIsStale, onHover])

  const colours = useColours(axes)
  const options = useMemo(() => chartOptions(axes, xDomain, colours), [axes, xDomain, colours])
  const { containerRef, figure, width } = usePlot(options)

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const x = figure?.scale('x')
      if (figure === null || x?.invert === undefined) return
      const pointerX = event.clientX - figure.getBoundingClientRect().left
      const inverted: unknown = x.invert(pointerX)
      if (!(inverted instanceof Date)) return
      const clamped = Math.min(
        Math.max(inverted.getTime(), xDomain[0].epochMillis),
        xDomain[1].epochMillis
      )
      const snapped = Crosshair.nearestStop(stops, clamped)
      // Most moves stay on the same stop; only a new one is news to `onHover`.
      if (snapped === hoveredMillis) return
      setHover({ stops, millis: snapped })
      onHover?.(DateTime.unsafeMake(snapped))
    },
    [figure, stops, xDomain, hoveredMillis, onHover]
  )

  const handlePointerLeave = useCallback(() => {
    setHover(null)
    onHover?.(null)
  }, [onHover])

  if (axes.length === 0) {
    return <p className={styles.empty}>Pick up to four series</p>
  }

  const crosshairLeft: unknown =
    hoveredMillis === null ? null : figure?.scale('x')?.apply(new Date(hoveredMillis))

  return (
    <div className={styles.chart}>
      <Legend axes={axes} colours={colours} />
      <div
        className={styles['plot-area']}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        <div ref={containerRef} className={styles.figure} />
        {hoveredMillis === null || typeof crosshairLeft !== 'number' ? null : (
          <>
            <div
              className={styles.crosshair}
              style={{ left: crosshairLeft, top: MARGIN_TOP, height: FRAME_HEIGHT }}
              data-testid="crosshair-rule"
              aria-hidden="true"
            />
            <CrosshairTooltip
              axes={axes}
              colours={colours}
              time={DateTime.unsafeMake(hoveredMillis)}
              left={crosshairLeft}
              flip={crosshairLeft + TOOLTIP_ROOM > width}
            />
          </>
        )}
      </div>
    </div>
  )
}

export type { MultiAxisChartProps }
export { MultiAxisChart }
