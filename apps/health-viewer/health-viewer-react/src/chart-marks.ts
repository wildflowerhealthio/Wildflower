import * as Plot from '@observablehq/plot'
import type { DateTime } from 'effect'

import {
  type Buckets,
  type Level,
  type LevelSeries,
  type PointSeries,
  type TimeDomain,
  ValueAxis,
} from 'health-viewer-fundamentals'

import { seriesColors } from './series-colors.ts'
import { axisTickFormat, labelWithUnit } from './value-format.ts'

/**
 * Horizontal room each stacked value axis takes in its gutter: tick marks,
 * tick labels up to five characters, and the rotated series label beside them.
 */
const AXIS_GUTTER = 64

/** How far inside its gutter's outer edge an axis' rotated label sits. */
const LABEL_INSET = 3

/** Room on a side that carries no value axis, so the last x tick label is not clipped. */
const BARE_SIDE_MARGIN = 24

/** Room above the plot, so the top tick label is not clipped. */
const MARGIN_TOP = 16

/** Room below the plot for the time axis' tick labels. */
const MARGIN_BOTTOM = 32

/** The figure's height; its width follows the container. */
const CHART_HEIGHT = 360

/** The plot frame's height: what the crosshair rule spans below {@link MARGIN_TOP}. */
const FRAME_HEIGHT = CHART_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM

/** Pixels between time ticks — shared by the grid and the axis so every grid line has a label. */
const X_TICK_SPACING = 96

/**
 * How wide one bucket of a dense point series is drawn, in pixels — about one
 * dot across (`r: 4` plus its 2px ring), so a series with more readings in
 * the window than {@link bucketCountFor} buckets would draw dots that touch.
 */
const BUCKET_WIDTH = 10

/** Where a figure hangs its value axes: its left and right margins, in pixels. */
const sideMargin = (
  axes: readonly ValueAxis.ValueAxis[],
  side: ValueAxis.ValueAxis['side']
): number => {
  const count = axes.filter((axis) => axis.side === side).length
  return count === 0 ? BARE_SIDE_MARGIN : count * AXIS_GUTTER
}

/**
 * How far an axis sits from the plot edge, signed outward: left axes step
 * left, right axes step right, `0` for the one nearest the plot.
 */
const axisOffset = (axis: ValueAxis.ValueAxis): number =>
  (axis.side === 'left' ? -1 : 1) * axis.index * AXIS_GUTTER

/**
 * How many buckets a dense point series is drawn in across a figure
 * `figureWidth` pixels wide: one per {@link BUCKET_WIDTH} of the plot frame,
 * the gutters aside, and at least one.
 */
const bucketCountFor = (axes: readonly ValueAxis.ValueAxis[], figureWidth: number): number => {
  const frameWidth = figureWidth - sideMargin(axes, 'left') - sideMargin(axes, 'right')
  return Math.max(1, Math.floor(frameWidth / BUCKET_WIDTH))
}

/** A vertex of a drawn line, on the shared `0..1` value scale. */
interface PlottedVertex {
  readonly time: Date
  readonly y: number
}

/**
 * A point series' band at one reading, on the `0..1` scale; `NaN` where the
 * reading carried none, so the band breaks there.
 */
interface PointBandVertex {
  readonly time: Date
  readonly low: number
  readonly high: number
}

/**
 * A vertex of a bucketed series' mean line and min–max envelope, on the `0..1`
 * scale; all three `NaN` where the line and envelope break.
 */
interface BucketVertex {
  readonly time: Date
  readonly mean: number
  readonly min: number
  readonly max: number
}

/** One level's band: the level's span by its `low` / `high`, on the `0..1` scale. */
interface LevelBandRect {
  readonly start: Date
  readonly end: Date
  readonly low: number
  readonly high: number
}

/** The instant a mark draws at. */
const toDate = (time: DateTime.Utc): Date => new Date(time.epochMillis)

/**
 * The Plot curve for a point series' interpolation: straight between
 * readings, or each reading held flat until the next (`step-after`).
 */
const curveFor = (interpolation: PointSeries.Interpolation): 'linear' | 'step-after' =>
  interpolation === 'step' ? 'step-after' : 'linear'

/**
 * How much of the `-soft` token a band paints. The token alone is an 18%
 * (dark: 22%) wash, and two series' bands routinely overlap — at full strength
 * the overlap stacks into a solid block that outweighs the lines. Halved, each
 * band is the ~10% wash the dataviz guidance asks of an area fill, and an
 * overlap still reads as two light washes.
 */
const BAND_OPACITY = 0.55

/**
 * The band behind a point series — an area between each reading's `low` and
 * `high`, broken at readings without one — or nothing when no reading carries
 * a band.
 */
const pointBandMarks = (
  axis: ValueAxis.ValueAxis,
  series: PointSeries.PointSeries,
  colour: number
): readonly Plot.Markish[] => {
  const band: readonly PointBandVertex[] = series.points.map((point) => ({
    time: toDate(point.time),
    low: point.low === undefined ? Number.NaN : ValueAxis.normalise(point.low, axis.domain),
    high: point.high === undefined ? Number.NaN : ValueAxis.normalise(point.high, axis.domain),
  }))
  const hasBand = band.some((vertex) => !Number.isNaN(vertex.low) && !Number.isNaN(vertex.high))
  if (!hasBand) return []
  return [
    Plot.areaY(band, {
      x: 'time',
      y1: 'low',
      y2: 'high',
      fill: seriesColors(colour).band,
      fillOpacity: BAND_OPACITY,
      curve: curveFor(series.interpolation),
      clip: true,
    }),
  ]
}

/**
 * The vertices a bucketed series is drawn through: each bucket's middle, the
 * buckets in runs of adjacent slices, with a `NaN` vertex between runs so the
 * line and envelope break across a left-out slice rather than bridging it.
 *
 * @remarks
 * Each run also opens at its first slice's start and closes at its last
 * slice's end, holding that bucket's values: a run of one bucket would
 * otherwise be a single vertex, which a line or area draws as nothing.
 */
const bucketVertices = (
  axis: ValueAxis.ValueAxis,
  buckets: readonly Buckets.Bucket[]
): readonly BucketVertex[] => {
  const vertexAt = (time: DateTime.Utc, bucket: Buckets.Bucket): BucketVertex => ({
    time: toDate(time),
    mean: ValueAxis.normalise(bucket.mean, axis.domain),
    min: ValueAxis.normalise(bucket.min, axis.domain),
    max: ValueAxis.normalise(bucket.max, axis.domain),
  })
  return buckets.flatMap((bucket, index) => {
    const previous = buckets[index - 1]
    const next = buckets[index + 1]
    const opensRun = previous?.end.epochMillis !== bucket.start.epochMillis
    const closesRun = next?.start.epochMillis !== bucket.end.epochMillis
    const breakBefore: readonly BucketVertex[] =
      opensRun && previous !== undefined
        ? [{ time: toDate(bucket.start), mean: Number.NaN, min: Number.NaN, max: Number.NaN }]
        : []
    return [
      ...breakBefore,
      ...(opensRun ? [vertexAt(bucket.start, bucket)] : []),
      vertexAt(bucket.time, bucket),
      ...(closesRun ? [vertexAt(bucket.end, bucket)] : []),
    ]
  })
}

/**
 * The envelope behind a bucketed series — an area from each bucket's `min` to
 * its `max` — in place of its readings' own band, which a bucket does not
 * summarise.
 */
const bucketEnvelopeMarks = (
  axis: ValueAxis.ValueAxis,
  series: PointSeries.PointSeries,
  buckets: readonly Buckets.Bucket[],
  colour: number
): readonly Plot.Markish[] => [
  Plot.areaY(bucketVertices(axis, buckets), {
    x: 'time',
    y1: 'min',
    y2: 'max',
    fill: seriesColors(colour).band,
    fillOpacity: BAND_OPACITY,
    curve: curveFor(series.interpolation),
    clip: true,
  }),
]

/**
 * The band behind a level series — one rectangle per level carrying both
 * `low` and `high`, over that level's span — or nothing when none does.
 *
 * @param domainEnd - Where an open level's band is drawn to, as its line is
 *
 * @remarks
 * A rectangle per level rather than one area, so a gap between levels, or a
 * level without a band, simply leaves no wash.
 */
const levelBandMarks = (
  axis: ValueAxis.ValueAxis,
  series: LevelSeries.LevelSeries,
  colour: number,
  domainEnd: DateTime.Utc
): readonly Plot.Markish[] => {
  const rects: readonly LevelBandRect[] = series.levels.flatMap((level) =>
    level.low === undefined || level.high === undefined
      ? []
      : [
          {
            start: toDate(level.start),
            end: toDate(level.end ?? domainEnd),
            low: ValueAxis.normalise(level.low, axis.domain),
            high: ValueAxis.normalise(level.high, axis.domain),
          },
        ]
  )
  if (rects.length === 0) return []
  return [
    Plot.rect(rects, {
      x1: 'start',
      x2: 'end',
      y1: 'low',
      y2: 'high',
      fill: seriesColors(colour).band,
      fillOpacity: BAND_OPACITY,
      clip: true,
    }),
  ]
}

/**
 * The band behind an axis' series, whichever kind it is — for a bucketed
 * series, its envelope. The chart draws every band in a layer beneath every
 * line, so one series' band never washes over another's line.
 *
 * @param buckets - The series' buckets when it is drawn as them
 */
const seriesBandMarks = (
  axis: ValueAxis.ValueAxis,
  colour: number,
  domainEnd: DateTime.Utc,
  buckets: readonly Buckets.Bucket[] | undefined
): readonly Plot.Markish[] => {
  if (axis.series.kind === 'levels') return levelBandMarks(axis, axis.series, colour, domainEnd)
  return buckets === undefined
    ? pointBandMarks(axis, axis.series, colour)
    : bucketEnvelopeMarks(axis, axis.series, buckets, colour)
}

/**
 * The marks for a point series: its line, curved as its interpolation says,
 * then its dots, each ringed in the card surface so it stays legible where
 * lines cross it.
 */
const pointSeriesMarks = (
  axis: ValueAxis.ValueAxis,
  series: PointSeries.PointSeries,
  colour: number
): readonly Plot.Markish[] => {
  const colors = seriesColors(colour)
  const vertices: readonly PlottedVertex[] = series.points.map((point) => ({
    time: toDate(point.time),
    y: ValueAxis.normalise(point.value, axis.domain),
  }))
  return [
    Plot.line(vertices, {
      x: 'time',
      y: 'y',
      stroke: colors.mark,
      strokeWidth: 2,
      curve: curveFor(series.interpolation),
      clip: true,
    }),
    Plot.dot(vertices, {
      x: 'time',
      y: 'y',
      r: 4,
      fill: colors.mark,
      stroke: 'var(--color-background)',
      strokeWidth: 2,
      clip: true,
    }),
  ]
}

/**
 * The marks for a bucketed series: a line through each bucket's mean, curved
 * as the series' interpolation says, and no dots — a dot per bucket would
 * touch its neighbours, which is why the series is bucketed.
 */
const bucketMeanMarks = (
  axis: ValueAxis.ValueAxis,
  series: PointSeries.PointSeries,
  buckets: readonly Buckets.Bucket[],
  colour: number
): readonly Plot.Markish[] => [
  Plot.line(bucketVertices(axis, buckets), {
    x: 'time',
    y: 'mean',
    stroke: seriesColors(colour).mark,
    strokeWidth: 2,
    curve: curveFor(series.interpolation),
    clip: true,
  }),
]

/**
 * One unbroken stretch of a level series' step line, all in one line style.
 *
 * @remarks
 * A run ends where the series has a gap (nothing in effect, so no line) or
 * where the line style changes (Plot dashes a whole mark, not a datum).
 */
interface LevelRun {
  readonly lineStyle: LevelSeries.LineStyle
  readonly vertices: readonly PlottedVertex[]
}

/** Whether `next` starts no later than `previous` ends — no gap between them. */
const touches = (previous: Level.Level | null, next: Level.Level): boolean =>
  previous !== null && previous.end !== null && previous.end.epochMillis >= next.start.epochMillis

/**
 * Split a level series' levels into the runs its step line draws.
 *
 * @param domainEnd - Where an open level (`end: null`) is drawn to: it is still
 *   in effect, so its line reaches the edge of the window
 *
 * @remarks
 * Each run lists every level's start plus the last level's end, drawn with
 * `step-after`, so a change of value is a vertical step at the new level's
 * start. A run that continues a touching one in another line style opens on
 * the previous value at its own start, so the step between the two is still
 * drawn.
 */
const levelRuns = (
  axis: ValueAxis.ValueAxis,
  levels: readonly LevelSeries.StyledLevel[],
  domainEnd: DateTime.Utc
): readonly LevelRun[] => {
  const runs: LevelRun[] = []
  let current: { lineStyle: LevelSeries.LineStyle; vertices: PlottedVertex[] } | null = null
  let previous: LevelSeries.StyledLevel | null = null
  for (const level of levels) {
    const end = level.end ?? domainEnd
    const y = ValueAxis.normalise(level.value, axis.domain)
    const continues = touches(previous, level)
    if (current === null || !continues || current.lineStyle !== level.lineStyle) {
      if (current !== null) runs.push(current)
      const lead: PlottedVertex[] =
        continues && previous !== null
          ? [{ time: toDate(level.start), y: ValueAxis.normalise(previous.value, axis.domain) }]
          : []
      current = { lineStyle: level.lineStyle, vertices: lead }
    } else {
      // Touching and in the same style: drop the previous level's closing
      // vertex so the step lands at this level's start.
      current.vertices.pop()
    }
    current.vertices.push({ time: toDate(level.start), y }, { time: toDate(end), y })
    previous = level
  }
  if (current !== null) runs.push(current)
  return runs
}

/** The SVG dash array each line style strokes with; `undefined` draws it solid. */
const LINE_STYLE_DASH_ARRAY: Readonly<Record<LevelSeries.LineStyle, string | undefined>> = {
  solid: undefined,
  dashed: '6 4',
}

/** The marks for a level series: one step line per {@link LevelRun}. */
const levelSeriesMarks = (
  axis: ValueAxis.ValueAxis,
  series: LevelSeries.LevelSeries,
  colour: number,
  domainEnd: DateTime.Utc
): readonly Plot.Markish[] => {
  const colors = seriesColors(colour)
  return levelRuns(axis, series.levels, domainEnd).map((run) => {
    const dashArray = LINE_STYLE_DASH_ARRAY[run.lineStyle]
    return Plot.line(run.vertices, {
      x: 'time',
      y: 'y',
      stroke: colors.mark,
      strokeWidth: 2,
      curve: 'step-after',
      ...(dashArray === undefined ? {} : { strokeDasharray: dashArray }),
      clip: true,
    })
  })
}

/**
 * The marks that draw an axis' series itself, whichever kind it is.
 *
 * @param buckets - The series' buckets when it is drawn as them
 */
const seriesLineMarks = (
  axis: ValueAxis.ValueAxis,
  colour: number,
  domainEnd: DateTime.Utc,
  buckets: readonly Buckets.Bucket[] | undefined
): readonly Plot.Markish[] => {
  if (axis.series.kind === 'levels') return levelSeriesMarks(axis, axis.series, colour, domainEnd)
  return buckets === undefined
    ? pointSeriesMarks(axis, axis.series, colour)
    : bucketMeanMarks(axis, axis.series, buckets, colour)
}

/**
 * A value axis' own marks: a series-coloured axis line and tick marks at its
 * offset, labels in the text colour, placed at its ticks on the shared `0..1`
 * scale and labelled back in the series' own values.
 */
const valueAxisMarks = (
  axis: ValueAxis.ValueAxis,
  colour: number,
  xDomain: TimeDomain.TimeDomain
): Plot.Markish[] => {
  const colors = seriesColors(colour)
  const offset = axisOffset(axis)
  return [
    Plot.ruleX([toDate(axis.side === 'left' ? xDomain[0] : xDomain[1])], {
      y1: 0,
      y2: 1,
      dx: offset,
      stroke: colors.mark,
    }),
    Plot.axisY(
      axis.ticks.map((tick) => ValueAxis.normalise(tick, axis.domain)),
      {
        anchor: axis.side,
        dx: offset,
        stroke: colors.mark,
        fill: 'currentColor',
        tickFormat: axisTickFormat(axis),
        label: labelWithUnit(axis.series),
        labelAnchor: 'center',
        labelArrow: 'none',
        // Plot places an axis label from the frame edge and ignores `dx`, so
        // each stacked label is pushed out to the far side of its own gutter.
        labelOffset: (axis.index + 1) * AXIS_GUTTER - LABEL_INSET,
      }
    ),
  ]
}

/**
 * The figure's options, bottom layer first: time grid and axis, every value
 * axis, every band, and every series' lines and dots in axis order.
 *
 * @param colours - Each axis' palette index, parallel to `axes` — from
 *   `ColourSlots.assign`, so a series keeps its colour when an earlier one is
 *   removed
 * @param bucketsBySeriesId - The series drawn as buckets, from
 *   `Buckets.ofDenseSeries`: a mean line over a min–max envelope, no dots
 *
 * @returns `null` for an empty selection — there is nothing to draw
 *
 * @remarks
 * The crosshair is not a mark: it moves on every pointer move, and drawing it
 * here would rebuild the whole figure each time it does. The chart overlays it
 * in HTML over {@link FRAME_HEIGHT} instead.
 */
const chartOptions = (
  axes: readonly ValueAxis.ValueAxis[],
  xDomain: TimeDomain.TimeDomain,
  colours: readonly number[],
  bucketsBySeriesId: ReadonlyMap<string, readonly Buckets.Bucket[]>
): Plot.PlotOptions | null => {
  if (axes.length === 0) return null
  const domainEnd = xDomain[1]
  const marks: Plot.Markish[] = [
    Plot.gridX({ strokeOpacity: 0.08, tickSpacing: X_TICK_SPACING }),
    Plot.axisX({ label: null, tickSpacing: X_TICK_SPACING }),
    ...axes.flatMap((axis, position) => valueAxisMarks(axis, colours[position], xDomain)),
    ...axes.flatMap((axis, position) =>
      seriesBandMarks(axis, colours[position], domainEnd, bucketsBySeriesId.get(axis.series.id))
    ),
    ...axes.flatMap((axis, position) =>
      seriesLineMarks(axis, colours[position], domainEnd, bucketsBySeriesId.get(axis.series.id))
    ),
  ]
  return {
    height: CHART_HEIGHT,
    marginTop: MARGIN_TOP,
    marginBottom: MARGIN_BOTTOM,
    marginLeft: sideMargin(axes, 'left'),
    marginRight: sideMargin(axes, 'right'),
    x: { type: 'utc', domain: [toDate(xDomain[0]), toDate(xDomain[1])] },
    y: { domain: [0, 1], axis: null },
    marks,
  }
}

export type { BucketVertex, LevelRun, PlottedVertex }
export {
  BUCKET_WIDTH,
  FRAME_HEIGHT,
  MARGIN_TOP,
  bucketCountFor,
  bucketVertices,
  chartOptions,
  levelRuns,
}
