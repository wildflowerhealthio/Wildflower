import * as Plot from '@observablehq/plot'
import type { JSX } from 'react'
import { useMemo } from 'react'

import {
  type ColourSlots,
  type Level,
  Scatter,
  type Series,
  type TimeDomain,
  ValueAxis,
} from '@wildflowerhealthio/plots-fundamentals'

import { colourSlotOf, seriesColors } from './series-colors.ts'
import { usePlot, usePlotContainer } from './use-plot.ts'
import { formatDateTime, formatReading, labelWithUnit, valueTickFormat } from './value-format.ts'
import styles from './scatter-chart.module.css'

interface ScatterChartProps {
  /** The series along the x axis: the first value series selected. */
  readonly x: Series.ValueSeries
  /** The series along the y axis: the second value series selected. */
  readonly y: Series.ValueSeries
  /** The time window X's readings are drawn from: the range preset's. */
  readonly timeWindow: TimeDomain.TimeDomain
  /** Each selected value series' palette index, kept by the page with `useColourSlots`. */
  readonly colours: ColourSlots.ColourSlots
}

/** The figure's height: square-ish beside the time chart's width, short enough to sit above the fold. */
const SCATTER_HEIGHT = 400

/** A dot's radius — the dataviz minimum of an 8px marker. */
const DOT_RADIUS = 4

/** A value as the readout says it: the number, its unit and the domain's note. */
const readingText = (series: Series.ValueSeries, level: Level.Level): string =>
  [formatReading(level.value), series.unit, level.note]
    .filter((part) => part !== null && part !== undefined)
    .join(' ')

/** The hover readout for one pair: when X was read, then both values by series. */
const pairTitle =
  (x: Series.ValueSeries, y: Series.ValueSeries) =>
  (pair: Scatter.Pair): string =>
    [
      formatDateTime(pair.time),
      `${x.label}: ${readingText(x, pair.x)}`,
      `${y.label}: ${readingText(y, pair.y)}`,
    ].join('\n')

/** Where a pair sits along the x axis: X's value. */
const xValue = (pair: Scatter.Pair): number => pair.x.value

/** Where a pair sits along the y axis: Y's value at X's time. */
const yValue = (pair: Scatter.Pair): number => pair.y.value

/** One value axis' scale: the domain and ticks `ValueAxis` fits the series' own values to. */
const scaleOf = (series: Series.ValueSeries): { domain: ValueAxis.Domain; ticks: number[] } => {
  const domain = ValueAxis.domainFor(series)
  return { domain, ticks: [...ValueAxis.ticksFor(domain)] }
}

/**
 * The scatter's options: a hairline grid, an axis per series labelled with
 * its unit, a dot per pair in `dotColour` ringed in the surface colour, and a
 * tip on the pair nearest the pointer.
 */
const scatterOptions = (
  scatter: Scatter.Scatter,
  x: Series.ValueSeries,
  y: Series.ValueSeries,
  dotColour: string
): Plot.PlotOptions => {
  const xScale = scaleOf(x)
  const yScale = scaleOf(y)
  return {
    height: SCATTER_HEIGHT,
    marginLeft: 56,
    marginBottom: 44,
    ariaLabel: `${y.label} against ${x.label}`,
    x: { domain: xScale.domain },
    y: { domain: yScale.domain },
    marks: [
      Plot.gridX({ ticks: xScale.ticks, strokeOpacity: 0.08 }),
      Plot.gridY({ ticks: yScale.ticks, strokeOpacity: 0.08 }),
      Plot.axisX({
        ticks: xScale.ticks,
        tickFormat: valueTickFormat(xScale),
        label: labelWithUnit(x),
        labelAnchor: 'center',
        labelArrow: 'none',
      }),
      Plot.axisY({
        ticks: yScale.ticks,
        tickFormat: valueTickFormat(yScale),
        label: labelWithUnit(y),
        labelAnchor: 'center',
        labelArrow: 'none',
      }),
      Plot.dot(scatter.pairs, {
        x: xValue,
        y: yValue,
        r: DOT_RADIUS,
        fill: dotColour,
        stroke: 'var(--color-background)',
        strokeWidth: 2,
      }),
      Plot.tip(
        scatter.pairs,
        Plot.pointer({
          x: xValue,
          y: yValue,
          title: pairTitle(x, y),
          fill: 'var(--color-raised)',
          stroke: 'var(--color-divider)',
        })
      ),
    ],
  }
}

/** How many X readings the scatter left out for want of a Y value. */
const unpairedNoteOf = (
  scatter: Scatter.Scatter,
  x: Series.ValueSeries,
  y: Series.ValueSeries
): string =>
  scatter.unpairedCount === 1
    ? `1 ${x.label} reading has no ${y.label} value at its time`
    : `${scatter.unpairedCount} ${x.label} readings have no ${y.label} value at their time`

/**
 * One value series against another: a dot for each X reading inside the
 * window, placed at its value and Y's at the same instant (`Scatter.of`) — the
 * value the time chart's crosshair reads there. Hovering names the nearest
 * pair's time and both values.
 *
 * @remarks
 * Each axis is fitted as the time chart fits that series (`ValueAxis.domainFor`),
 * so a dose axis still starts at zero. The pairs are one set, in the colour
 * X wears on the time chart (`colours`); the axes' labels say which series is
 * which. X readings with
 * no Y value at their time are counted under the figure rather than dropped
 * silently.
 */
const ScatterChart = ({ x, y, timeWindow, colours }: ScatterChartProps): JSX.Element => {
  const { containerRef, container, width } = usePlotContainer()
  const scatter = useMemo(() => Scatter.of(x, y, timeWindow), [x, y, timeWindow])
  const dotColour = seriesColors(colourSlotOf(colours, x.id)).mark
  const options = useMemo(
    () => scatterOptions(scatter, x, y, dotColour),
    [scatter, x, y, dotColour]
  )
  usePlot(container, width, options)
  return (
    <div className={styles['scatter-chart']}>
      <div ref={containerRef} className={styles['scatter-chart__figure']} />
      {scatter.pairs.length === 0 && scatter.unpairedCount === 0 ? (
        <p className={styles['scatter-chart__note']}>No {x.label} readings in this range</p>
      ) : null}
      {scatter.unpairedCount === 0 ? null : (
        <p className={styles['scatter-chart__note']}>{unpairedNoteOf(scatter, x, y)}</p>
      )}
    </div>
  )
}

export { ScatterChart }
export type { ScatterChartProps }
