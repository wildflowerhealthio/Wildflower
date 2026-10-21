import { DateTime } from 'effect'
import { type JSX, type PointerEvent, useCallback, useEffect, useMemo, useState } from 'react'

import {
  Buckets,
  ColourSlots,
  Crosshair,
  SpanSeries,
  type TimeDomain,
  type ValueAxis,
} from '@wildflowerhealthio/plots-fundamentals'

import { MARGIN_TOP, bucketCountFor, chartOptions, crosshairHeightFor } from './chart-marks.ts'
import { CrosshairTooltip } from './crosshair-tooltip.tsx'
import { Legend } from './legend.tsx'
import { usePlot, usePlotContainer } from './use-plot.ts'
import styles from './multi-axis-chart.module.css'

interface MultiAxisChartProps {
  /**
   * The value axes `ValueAxis.assign` produced, each with one or more series.
   * A series keeps its colour for as long as it stays selected, so removing
   * one never repaints the others; a newcomer takes the lowest colour left
   * free.
   */
  readonly axes: readonly ValueAxis.ValueAxis[]
  /**
   * The span series to draw as lanes under the time axis, in selection order,
   * at most `SpanSeries.LANE_CAP` of them. They take no value axis and no
   * series colour: each span wears its category's lane colour.
   */
  readonly lanes: readonly SpanSeries.SpanSeries[]
  /** The time window the x axis spans. */
  readonly xDomain: TimeDomain.TimeDomain
  /** Told the instant the crosshair moves to, and `null` when it leaves the figure. */
  readonly onHover?: ((time: DateTime.Utc | null) => void) | undefined
}

/** Room the tooltip needs beside the crosshair: its CSS `max-width` plus its `--space-5` gap from the rule. */
const TOOLTIP_ROOM = 280 + 12

/**
 * Each value series' palette index: `ColourSlots.assign` over every axis'
 * series, carried from one render to the next so a survivor keeps its colour.
 *
 * @remarks
 * Derived state rather than an effect: when the selection changes the new
 * assignment is stored during render, so the first paint already wears it.
 * The assignment returned is the stored one itself while the selection
 * holds, so the figure is not rebuilt for an unchanged one.
 */
const useColours = (axes: readonly ValueAxis.ValueAxis[]): ColourSlots.ColourSlots => {
  const ids = axes.flatMap((axis) => axis.series.map((series) => series.id))
  const [kept, setKept] = useState<ColourSlots.ColourSlots>(() =>
    ColourSlots.assign(new Map(), ids)
  )
  const current = ColourSlots.assign(kept, ids)
  if (current !== kept) setKept(current)
  return current
}

/**
 * Plots' chart: every selected series on one time axis, each against its
 * value axis — its own, colour-matched, or one it shares with series of the
 * same unit and a similar range; two axes on the left, two on the right —
 * with each series' `low` / `high` band shaded behind the lines and a
 * crosshair that reads every series at the pointer's time.
 *
 * @remarks
 * Deliberately a multi-axis overlay, the one recorded exception to the
 * dataviz guidance: the viewer exists to read one series against another it
 * is meant to move. Every series is drawn on a shared `0..1` scale through its
 * axis' domain, and each axis maps that scale back to the series' values —
 * the domains and ticks are `ValueAxis.assign`'s, not re-derived here.
 *
 * Span series are drawn as thin lanes under the time axis, one per series,
 * with no value axis: a bar per span in its category's colour.
 *
 * The crosshair snaps to the nearest `Crosshair.stops` boundary — a reading,
 * a level or a span starting or ending — across all series, and lists the
 * level each value series holds there (`Series.levelAt`) and the spans each
 * lane has there (`SpanSeries.spansAt`), so the pointer never has to land on
 * a line. The whole plot is the hit area.
 *
 * A point series with more readings in the window than the frame has room for
 * dots (`bucketCountFor` at the figure's width) is drawn as buckets — a mean
 * line over a min–max envelope — and read as them: its stops are the bucket
 * middles and its row the bucket's mean. `Buckets.ofDenseSeries` decides
 * which, once per render, and the marks, the stops and the readout all take
 * that one map; a new width decides again.
 */
const MultiAxisChart = ({ axes, lanes, xDomain, onHover }: MultiAxisChartProps): JSX.Element => {
  const { containerRef, container, width: figureWidth } = usePlotContainer()
  const valueSeries = useMemo(() => axes.flatMap((axis) => axis.series), [axes])
  const bucketsBySeriesId = useMemo(
    () => Buckets.ofDenseSeries(valueSeries, xDomain, bucketCountFor(axes, figureWidth)),
    [valueSeries, axes, xDomain, figureWidth]
  )
  const stops = useMemo(
    () => Crosshair.stops([...valueSeries, ...lanes], xDomain, bucketsBySeriesId),
    [valueSeries, lanes, xDomain, bucketsBySeriesId]
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
  // The legend re-renders on every crosshair move; its categories do not change with it.
  const laneCategories = useMemo(() => lanes.map((lane) => SpanSeries.categoriesOf(lane)), [lanes])
  const options = useMemo(
    () => chartOptions(axes, lanes, xDomain, colours, bucketsBySeriesId),
    [axes, lanes, xDomain, colours, bucketsBySeriesId]
  )
  const figure = usePlot(container, figureWidth, options)

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

  if (axes.length === 0 && lanes.length === 0) {
    return <p className={styles.empty}>Pick up to four series</p>
  }

  const crosshairLeft: unknown =
    hoveredMillis === null ? null : figure?.scale('x')?.apply(new Date(hoveredMillis))

  return (
    <div className={styles.chart}>
      <Legend axes={axes} colours={colours} lanes={lanes} laneCategories={laneCategories} />
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
              style={{
                left: crosshairLeft,
                top: MARGIN_TOP,
                height: crosshairHeightFor(lanes.length),
              }}
              data-testid="crosshair-rule"
              aria-hidden="true"
            />
            <CrosshairTooltip
              axes={axes}
              colours={colours}
              lanes={lanes}
              bucketsBySeriesId={bucketsBySeriesId}
              time={DateTime.unsafeMake(hoveredMillis)}
              left={crosshairLeft}
              flip={crosshairLeft + TOOLTIP_ROOM > figureWidth}
            />
          </>
        )}
      </div>
    </div>
  )
}

export type { MultiAxisChartProps }
export { MultiAxisChart }
