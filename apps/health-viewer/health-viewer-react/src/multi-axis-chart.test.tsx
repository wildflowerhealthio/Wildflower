import * as Plot from '@observablehq/plot'
import { type RenderResult, act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  Buckets,
  type LevelSeries,
  type PointSeries,
  Series,
  type TimeDomain,
  ValueAxis,
} from '@wildflowerhealthio/health-viewer-fundamentals'

import { bucketCountFor, bucketVertices, chartOptions, levelRuns } from './chart-marks.ts'
import { MultiAxisChart } from './multi-axis-chart.tsx'
import {
  WINDOW_DAYS,
  atDay,
  levelSeriesArb,
  pointSeriesArb,
  selectionArb,
  testWindow,
} from './series-arbitraries.test-helpers.ts'
import { seriesColors } from './series-colors.ts'
import { FALLBACK_WIDTH } from './use-plot.ts'
import { formatAxisValue, formatReading, tickDecimals } from './value-format.ts'

// Each run mounts a full Plot figure in jsdom, so the rendering properties run
// far fewer cases than a pure-function property would.
const RENDER_RUNS = numRunsFor({ base: 15 })
const RENDER_TIMEOUT = 30_000
const PURE_RUNS = numRunsFor({ base: 200 })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const readings: PointSeries.PointSeries = {
  kind: 'points',
  id: 'p:readings',
  label: 'Readings',
  unit: 'mg/dL',
  valueScale: 'fitted',
  interpolation: 'linear',
  points: [
    { time: atDay(0), value: 92 },
    { time: atDay(31), value: 118.4, low: 70, high: 100 },
    { time: atDay(60), value: 105 },
  ],
}
const levels: LevelSeries.LevelSeries = {
  kind: 'levels',
  id: 'l:levels',
  label: 'Levels',
  unit: 'mg',
  valueScale: 'from-zero',
  levels: [{ start: atDay(14), end: null, value: 1000, lineStyle: 'solid', note: 'per day' }],
}

const renderChart = (axes: readonly ValueAxis.ValueAxis[]): RenderResult =>
  render(<MultiAxisChart axes={axes} xDomain={testWindow} />)

/** The plot frame Plot clips marks to — the rendered extent of the x and y ranges. */
interface Frame {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const frameOf = (container: HTMLElement): Frame => {
  const rect = container.querySelector('clipPath rect')
  if (rect === null) throw new Error('the figure has no clipped marks')
  const read = (name: string): number => Number(rect.getAttribute(name))
  return { x: read('x'), y: read('y'), width: read('width'), height: read('height') }
}

/** Each rendered mark group of `kind` (`line`, `dot`, …) with the stroke its paths inherit. */
const markStrokes = (container: HTMLElement, kind: string): readonly (string | null)[] =>
  [...container.querySelectorAll(`svg > g[aria-label="${kind}"]`)].map(
    (group) => group.querySelector('g[stroke]')?.getAttribute('stroke') ?? null
  )

/** The fill each rendered mark group of `kind` (`area`, `rect`) paints its band in. */
const markFills = (container: HTMLElement, kind: string): readonly (string | null)[] =>
  [...container.querySelectorAll(`svg > g[aria-label="${kind}"]`)].map(
    (group) => group.querySelector('[fill]')?.getAttribute('fill') ?? null
  )

/** The plot area the chart listens for pointer moves on. */
const plotAreaOf = (container: HTMLElement): HTMLElement => {
  const plotArea = container.querySelector('svg')?.parentElement?.parentElement
  if (plotArea == null) throw new Error('no plot area')
  return plotArea
}

describe('MultiAxisChart axes', () => {
  test(
    'draws one value axis per series, labelled with ValueAxis.ticksFor and coloured as its line',
    () => {
      fc.assert(
        fc.property(selectionArb(pointSeriesArb), (selected) => {
          const axes = ValueAxis.assign(selected)
          const { container } = renderChart(axes)

          const tickLabelGroups = container.querySelectorAll('[aria-label="y-axis tick label"]')
          const tickGroups = container.querySelectorAll('[aria-label="y-axis tick"]')
          expect(tickLabelGroups).toHaveLength(axes.length)
          expect(tickGroups).toHaveLength(axes.length)

          const lineStrokes = markStrokes(container, 'line')
          axes.forEach((axis, position) => {
            const expectedLabels = ValueAxis.ticksFor(axis.domain).map((tick) =>
              formatAxisValue(tick, tickDecimals(axis))
            )
            const renderedLabels = [...tickLabelGroups[position].querySelectorAll('text')].map(
              (text) => text.textContent
            )
            expect(renderedLabels).toEqual(expectedLabels)

            const token = seriesColors(position).mark
            expect(tickGroups[position].getAttribute('stroke')).toBe(token)
            // Point series only: exactly one line mark per axis, in axis order.
            expect(lineStrokes[position]).toBe(token)
          })
          cleanup()
        }),
        { numRuns: RENDER_RUNS }
      )
    },
    RENDER_TIMEOUT
  )

  test('hangs each axis on the side ValueAxis.assign chose, stepping outward by index', () => {
    const axes = ValueAxis.assign(
      ['a', 'b', 'c', 'd'].map((tag): PointSeries.PointSeries => ({ ...readings, id: `p:${tag}` }))
    )
    const { container } = renderChart(axes)
    const frame = frameOf(container)
    const tickXs = [...container.querySelectorAll('[aria-label="y-axis tick"]')].map((group) => {
      const first = group.querySelector('path')?.getAttribute('transform') ?? ''
      const groupShift = Number(
        /translate\(([-\d.]+)/.exec(group.getAttribute('transform') ?? '')?.[1] ?? 0
      )
      return Number(/translate\(([-\d.]+)/.exec(first)?.[1]) + groupShift
    })
    axes.forEach((axis, position) => {
      const edge = axis.side === 'left' ? frame.x : frame.x + frame.width
      const outward =
        axis.side === 'left' ? tickXs[position] <= edge + 1 : tickXs[position] >= edge - 1
      expect(outward).toBe(true)
    })
    const [left0, right0, left1, right1] = tickXs
    expect(left1).toBeLessThan(left0)
    expect(right1).toBeGreaterThan(right0)
  })
})

describe('MultiAxisChart time axis', () => {
  test('draws a grid line at every labelled time tick and nowhere else, at any width', () => {
    const options = chartOptions(
      ValueAxis.assign([readings, levels]),
      testWindow,
      [0, 1],
      new Map()
    )
    if (options === null) throw new Error('a non-empty selection has a figure')
    fc.assert(
      fc.property(fc.integer({ min: 320, max: 2400 }), (width) => {
        const figure = Plot.plot({ ...options, width })
        const xOf = (selector: string): readonly number[] =>
          [...figure.querySelectorAll(selector)].map((element) => {
            const translate = /translate\(([-\d.]+)/.exec(element.getAttribute('transform') ?? '')
            return Number(translate?.[1] ?? element.getAttribute('x1'))
          })
        const tickXs = xOf('[aria-label="x-axis tick"] path')
        expect(tickXs.length).toBeGreaterThan(0)
        expect(xOf('[aria-label="x-grid"] line')).toEqual(tickXs)
      }),
      { numRuns: RENDER_RUNS }
    )
  })
})

describe('tickDecimals', () => {
  test('labels a nice step with exactly its own decimals, whatever float error its ticks carry', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -6, max: 3 }),
        fc.constantFrom(1, 2, 5),
        fc.integer({ min: -1000, max: 1000 }),
        (exponent, multiplier, index) => {
          const step = multiplier * 10 ** exponent
          const first = index * step
          const second = (index + 1) * step
          const axis: ValueAxis.ValueAxis = {
            ...ValueAxis.assign([readings])[0],
            domain: [first, second],
            ticks: [first, second],
          }
          expect(tickDecimals(axis)).toBe(Math.max(0, -exponent))
        }
      ),
      { numRuns: PURE_RUNS }
    )
  })
})

/** The vertices of a rendered SVG line path, in drawing order. */
const verticesOf = (path: Element): readonly (readonly [number, number])[] =>
  [...(path.getAttribute('d') ?? '').matchAll(/[ML]([-\d.e]+),([-\d.e]+)/g)].map(
    ([, x, y]) => [Number(x), Number(y)] as const
  )

describe('MultiAxisChart marks', () => {
  test(
    'every rendered point lies inside the plot frame',
    () => {
      fc.assert(
        fc.property(selectionArb(pointSeriesArb), (selected) => {
          const { container } = renderChart(ValueAxis.assign(selected))
          const frame = frameOf(container)
          const circles = [...container.querySelectorAll('svg > g[aria-label="dot"] circle')]
          const pointCount = selected.reduce((total, series) => total + Series.sizeOf(series), 0)
          expect(circles).toHaveLength(pointCount)
          for (const circle of circles) {
            const cy = Number(circle.getAttribute('cy'))
            expect(cy).toBeGreaterThanOrEqual(frame.y)
            expect(cy).toBeLessThanOrEqual(frame.y + frame.height)
          }
          cleanup()
        }),
        { numRuns: RENDER_RUNS }
      )
    },
    RENDER_TIMEOUT
  )

  test(
    'strokes dashed levels with a dash array and solid ones without',
    () => {
      fc.assert(
        fc.property(selectionArb(levelSeriesArb), (selected) => {
          const { container } = renderChart(ValueAxis.assign(selected))
          const lines = [...container.querySelectorAll('svg > g[aria-label="line"] > g')]
          const dashedLines = lines.filter((line) => line.getAttribute('stroke-dasharray') !== null)
          const lineStyles = selected.flatMap((series) =>
            series.kind === 'levels' ? series.levels.map((level) => level.lineStyle) : []
          )
          expect(dashedLines.length > 0).toBe(lineStyles.includes('dashed'))
          expect(lines.length > dashedLines.length).toBe(lineStyles.includes('solid'))
          cleanup()
        }),
        { numRuns: RENDER_RUNS }
      )
    },
    RENDER_TIMEOUT
  )

  test(
    'shades a band only behind a point series whose readings carry one',
    () => {
      fc.assert(
        fc.property(selectionArb(pointSeriesArb), (selected) => {
          const { container } = renderChart(ValueAxis.assign(selected))
          const expected = selected.flatMap((series, position) =>
            series.kind === 'points' &&
            series.points.some((point) => point.low !== undefined && point.high !== undefined)
              ? [seriesColors(position).band]
              : []
          )
          expect(markFills(container, 'area')).toEqual(expected)
          cleanup()
        }),
        { numRuns: RENDER_RUNS }
      )
    },
    RENDER_TIMEOUT
  )

  test(
    'shades one band rectangle per level that carries one, in its series colour',
    () => {
      fc.assert(
        fc.property(selectionArb(levelSeriesArb), (selected) => {
          const { container } = renderChart(ValueAxis.assign(selected))
          const bandedCounts = selected.map((series) =>
            series.kind === 'levels'
              ? series.levels.filter((level) => level.low !== undefined && level.high !== undefined)
                  .length
              : 0
          )
          expect(markFills(container, 'rect')).toEqual(
            bandedCounts.flatMap((count, position) =>
              count > 0 ? [seriesColors(position).band] : []
            )
          )
          const rectCounts = [...container.querySelectorAll('svg > g[aria-label="rect"]')].map(
            (group) => group.querySelectorAll('rect').length
          )
          expect(rectCounts).toEqual(bandedCounts.filter((count) => count > 0))
          cleanup()
        }),
        { numRuns: RENDER_RUNS }
      )
    },
    RENDER_TIMEOUT
  )

  test(
    'draws a step point series step-after: each reading held flat until the next, then stepped',
    () => {
      fc.assert(
        fc.property(pointSeriesArb('s', 'step'), (series) => {
          const { container } = renderChart(ValueAxis.assign([series]))
          const path = container.querySelector('svg > g[aria-label="line"] path')
          if (path === null) throw new Error('the series drew no line')
          const vertices = verticesOf(path)
          // Two vertices per reading after the first: across at the old value, then up or down.
          expect(vertices).toHaveLength(2 * series.points.length - 1)
          for (let index = 1; index < vertices.length; index += 2) {
            const [from, corner, to] = [vertices[index - 1], vertices[index], vertices[index + 1]]
            expect(corner[1]).toBeCloseTo(from[1], 6)
            expect(corner[0]).toBeCloseTo(to[0], 6)
          }
          cleanup()
        }),
        { numRuns: RENDER_RUNS }
      )
    },
    RENDER_TIMEOUT
  )

  test('draws a linear point series straight from reading to reading', () => {
    const { container } = renderChart(ValueAxis.assign([readings]))
    const path = container.querySelector('svg > g[aria-label="line"] path')
    if (path === null) throw new Error('the series drew no line')
    expect(verticesOf(path)).toHaveLength(readings.points.length)
  })
})

describe('levelRuns', () => {
  const axisFor = (series: LevelSeries.LevelSeries): ValueAxis.ValueAxis =>
    ValueAxis.assign([series])[0]

  test('draws each level at its value from its start to its end, open ones to the window end', () => {
    fc.assert(
      fc.property(levelSeriesArb('l'), (series) => {
        const vertices = levelRuns(axisFor(series), series.levels, testWindow[1]).flatMap(
          (run) => run.vertices
        )
        for (const level of series.levels) {
          const end = (level.end ?? testWindow[1]).epochMillis
          expect(vertices.some((vertex) => vertex.time.getTime() === level.start.epochMillis)).toBe(
            true
          )
          expect(vertices.some((vertex) => vertex.time.getTime() === end)).toBe(true)
        }
      }),
      { numRuns: PURE_RUNS }
    )
  })

  test('breaks the line at a gap and never across one', () => {
    fc.assert(
      fc.property(levelSeriesArb('l'), (series) => {
        const runs = levelRuns(axisFor(series), series.levels, testWindow[1])
        // Each interval where nothing was in effect: from one level's stated end to a later start.
        const gaps = series.levels.flatMap((level, index) => {
          const previous = series.levels[index - 1]
          return previous?.end != null && previous.end.epochMillis < level.start.epochMillis
            ? [[previous.end.epochMillis, level.start.epochMillis] as const]
            : []
        })
        for (const [gapStart, gapEnd] of gaps) {
          // A run with vertices on both sides of the gap would draw a value across it.
          const spanning = runs.some(
            (run) =>
              run.vertices.some((vertex) => vertex.time.getTime() <= gapStart) &&
              run.vertices.some((vertex) => vertex.time.getTime() >= gapEnd)
          )
          expect(spanning).toBe(false)
        }
        for (const run of runs) {
          const times = run.vertices.map((vertex) => vertex.time.getTime())
          expect(times).toEqual([...times].toSorted((left, right) => left - right))
        }
      }),
      { numRuns: PURE_RUNS }
    )
  })

  test('starts a new run wherever the line style changes', () => {
    fc.assert(
      fc.property(levelSeriesArb('l'), (series) => {
        const runs = levelRuns(axisFor(series), series.levels, testWindow[1])
        const styleChanges = series.levels.filter(
          (level, index) => index > 0 && series.levels[index - 1].lineStyle !== level.lineStyle
        ).length
        expect(runs.length).toBeGreaterThanOrEqual(styleChanges + 1)
      }),
      { numRuns: PURE_RUNS }
    )
  })
})

describe('MultiAxisChart crosshair', () => {
  const axes = ValueAxis.assign([readings, levels])

  /** The client x of `day` inside the frame, as Plot's linear time scale places it. */
  const clientXFor = (container: HTMLElement, day: number): number => {
    const frame = frameOf(container)
    return frame.x + (day / WINDOW_DAYS) * frame.width
  }

  test('snaps to the nearest stop and lists each series’ level there', () => {
    const onHover = vi.fn()
    const { container } = render(
      <MultiAxisChart axes={axes} xDomain={testWindow} onHover={onHover} />
    )

    // Day 34 is nearest the day-31 reading (the level starting at 14 and the
    // reading at 60 are farther).
    fireEvent.pointerMove(plotAreaOf(container), { clientX: clientXFor(container, 34) })

    const snapped = atDay(31)
    expect(onHover.mock.lastCall?.[0]?.epochMillis).toBe(snapped.epochMillis)
    const rows = screen.getAllByTestId('crosshair-row')
    expect(rows).toHaveLength(axes.length)

    const reading = Series.levelAt(readings, snapped)
    const level = Series.levelAt(levels, snapped)
    if (reading === null || level === null) {
      throw new Error('fixture no longer reads a level on both series')
    }
    expect(rows[0].textContent).toContain(formatReading(reading.value))
    expect(rows[0].textContent).toContain('Readings')
    expect(rows[1].textContent).toContain(formatReading(level.value))
    expect(rows[1].textContent).toContain('per day')
    expect(rows[1].textContent).toContain('ongoing')

    // The crosshair rule is drawn at the snapped instant.
    const rule = screen.getByTestId('crosshair-rule')
    expect(Math.abs(Number.parseFloat(rule.style.left) - clientXFor(container, 31))).toBeLessThan(
      0.5
    )
  })

  test('drops the crosshair when the window changes under a resting pointer', () => {
    const onHover = vi.fn()
    const { container, rerender } = render(
      <MultiAxisChart axes={axes} xDomain={testWindow} onHover={onHover} />
    )

    fireEvent.pointerMove(plotAreaOf(container), { clientX: clientXFor(container, 34) })
    expect(screen.queryAllByTestId('crosshair-row')).not.toHaveLength(0)

    const later: TimeDomain.TimeDomain = [atDay(100), atDay(200)]
    rerender(<MultiAxisChart axes={axes} xDomain={later} onHover={onHover} />)
    expect(screen.queryAllByTestId('crosshair-row')).toHaveLength(0)
    expect(screen.queryByTestId('crosshair-rule')).toBeNull()
    expect(onHover).toHaveBeenLastCalledWith(null)
  })

  test('tells onHover only when the crosshair lands on a new stop', () => {
    const onHover = vi.fn()
    const { container } = render(
      <MultiAxisChart axes={axes} xDomain={testWindow} onHover={onHover} />
    )

    // Days 33 and 35 both snap to the day-31 reading.
    fireEvent.pointerMove(plotAreaOf(container), { clientX: clientXFor(container, 33) })
    fireEvent.pointerMove(plotAreaOf(container), { clientX: clientXFor(container, 35) })
    expect(onHover).toHaveBeenCalledTimes(1)
  })

  test('reads a level series as absent before its first level', () => {
    const { container } = render(<MultiAxisChart axes={axes} xDomain={testWindow} />)

    fireEvent.pointerMove(plotAreaOf(container), { clientX: clientXFor(container, 2) })

    const rows = screen.getAllByTestId('crosshair-row')
    expect(Series.levelAt(levels, atDay(0))).toBeNull()
    expect(rows[1].textContent).toContain('—')
  })

  test('hides the readout when the pointer leaves', () => {
    const onHover = vi.fn()
    const { container } = render(
      <MultiAxisChart axes={axes} xDomain={testWindow} onHover={onHover} />
    )

    fireEvent.pointerMove(plotAreaOf(container), { clientX: clientXFor(container, 34) })
    expect(screen.queryAllByTestId('crosshair-row')).not.toHaveLength(0)

    fireEvent.pointerLeave(plotAreaOf(container))
    expect(screen.queryAllByTestId('crosshair-row')).toHaveLength(0)
    expect(onHover).toHaveBeenLastCalledWith(null)
  })
})

describe('MultiAxisChart tooltip placement', () => {
  const axes = ValueAxis.assign([readings, levels])

  /** The readout with the crosshair on `day`, a reading, inside a window of `days`. */
  const tooltipAt = (day: number, days: number): HTMLElement => {
    const { container } = render(<MultiAxisChart axes={axes} xDomain={[atDay(0), atDay(days)]} />)
    const frame = frameOf(container)
    fireEvent.pointerMove(plotAreaOf(container), {
      clientX: frame.x + (day / days) * frame.width,
    })
    return screen.getByRole('status')
  }

  test('hangs right of the crosshair while it fits, past the middle included', () => {
    // The day-60 reading sits just right of centre in a 115-day window.
    expect(tooltipAt(60, 115).className).not.toContain('flipped')
  })

  test('flips left of the crosshair near the right edge', () => {
    expect(tooltipAt(60, 62).className).toContain('flipped')
  })
})

describe('MultiAxisChart colours', () => {
  const legendKeys = (container: HTMLElement): readonly (string | null)[] =>
    [...container.querySelectorAll('[aria-label="Series"] li span[aria-hidden]')].map((key) =>
      key.getAttribute('style')
    )

  test('removing an earlier series does not repaint the rest; a newcomer takes the freed colour', () => {
    const { container, rerender } = render(
      <MultiAxisChart axes={ValueAxis.assign([readings, levels])} xDomain={testWindow} />
    )
    expect(legendKeys(container)[1]).toContain(seriesColors(1).mark)

    rerender(<MultiAxisChart axes={ValueAxis.assign([levels])} xDomain={testWindow} />)
    expect(legendKeys(container)).toHaveLength(1)
    expect(legendKeys(container)[0]).toContain(seriesColors(1).mark)
    expect(markStrokes(container, 'line')).toEqual([seriesColors(1).mark])

    rerender(<MultiAxisChart axes={ValueAxis.assign([levels, readings])} xDomain={testWindow} />)
    expect(legendKeys(container)[0]).toContain(seriesColors(1).mark)
    expect(legendKeys(container)[1]).toContain(seriesColors(0).mark)
  })
})

describe('MultiAxisChart empty state', () => {
  test('prompts for a selection and draws no figure', () => {
    const { container } = renderChart([])
    expect(screen.getByText('Pick up to four series')).toBeDefined()
    expect(container.querySelector('svg')).toBeNull()
  })
})

/**
 * A point series of `count` readings spread evenly across {@link testWindow},
 * wandering between 50 and 110.
 */
const evenlySpread = (id: string, count: number): PointSeries.PointSeries => {
  const start = testWindow[0].epochMillis
  const span = testWindow[1].epochMillis - start
  return {
    kind: 'points',
    id,
    label: 'Heart rate',
    unit: 'beats/min',
    valueScale: 'fitted',
    interpolation: 'linear',
    points: Array.from({ length: count }, (_, index) => ({
      time: DateTime.unsafeMake(start + Math.floor((index * span) / count)),
      value: 80 + 30 * Math.sin(index / 40),
    })),
  }
}

describe('MultiAxisChart dense series', () => {
  test('draws a 10 000-reading series as a mean line over one envelope, without dots', () => {
    const dense = evenlySpread('p:dense', 10_000)
    const { container } = renderChart(ValueAxis.assign([dense]))
    expect(container.querySelectorAll('circle')).toHaveLength(0)
    const areas = container.querySelectorAll('svg > g[aria-label="area"]')
    expect(areas).toHaveLength(1)
    expect(areas[0].querySelectorAll('path')).toHaveLength(1)
    expect(markFills(container, 'area')).toEqual([seriesColors(0).band])
    expect(markStrokes(container, 'line')).toEqual([seriesColors(0).mark])
  })

  test('still draws a 20-reading series reading by reading, with its dots', () => {
    const { container } = renderChart(ValueAxis.assign([evenlySpread('p:sparse', 20)]))
    expect(container.querySelectorAll('svg > g[aria-label="dot"] circle')).toHaveLength(20)
    expect(container.querySelectorAll('svg > g[aria-label="area"]')).toHaveLength(0)
  })

  test('decides again at a new width: dots once the frame has room for every reading', () => {
    const observers: {
      readonly callback: ResizeObserverCallback
      readonly observer: ResizeObserver
    }[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push({ callback, observer: this })
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    const reportWidth = (width: number): void =>
      act(() => {
        for (const { callback, observer } of observers) {
          const entry: ResizeObserverEntry = {
            target: document.body,
            contentRect: DOMRectReadOnly.fromRect({ width, height: 0 }),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          }
          callback([entry], observer)
        }
      })

    const axes = ValueAxis.assign([evenlySpread('p:hundred', 100)])
    const { container } = renderChart(axes)
    // At the fallback width the frame holds fewer buckets than readings.
    expect(bucketCountFor(axes, FALLBACK_WIDTH)).toBeLessThan(100)
    expect(container.querySelectorAll('circle')).toHaveLength(0)

    reportWidth(2000)
    expect(bucketCountFor(axes, 2000)).toBeGreaterThanOrEqual(100)
    expect(container.querySelectorAll('svg > g[aria-label="dot"] circle')).toHaveLength(100)
  })

  test('the crosshair snaps to a bucket middle and reads its mean, count and range', () => {
    const dense = evenlySpread('p:dense', 10_000)
    const axes = ValueAxis.assign([dense, levels])
    const onHover = vi.fn()
    const { container } = render(
      <MultiAxisChart axes={axes} xDomain={testWindow} onHover={onHover} />
    )
    const frame = frameOf(container)
    fireEvent.pointerMove(plotAreaOf(container), {
      clientX: frame.x + (100 / WINDOW_DAYS) * frame.width,
    })

    const buckets = Buckets.of(dense.points, testWindow, bucketCountFor(axes, FALLBACK_WIDTH))
    const snapped: unknown = onHover.mock.lastCall?.[0]
    if (!DateTime.isDateTime(snapped)) throw new Error('the crosshair did not land')
    const bucket = Buckets.at(buckets, DateTime.toUtc(snapped))
    if (bucket === null) throw new Error('the crosshair landed outside every bucket')
    expect(bucket.time.epochMillis).toBe(snapped.epochMillis)

    const [denseRow] = screen.getAllByTestId('crosshair-row')
    expect(denseRow.textContent).toContain(`${formatReading(bucket.mean)} beats/min`)
    expect(denseRow.textContent).toContain(
      `mean of ${bucket.count} readings, ${formatReading(bucket.min)}–${formatReading(bucket.max)}`
    )
  })
})

describe('bucketVertices', () => {
  const axis = ValueAxis.assign([readings])[0]

  /** Buckets over a 1000ms window from readings at any of its instants. */
  const bucketsArb = fc
    .tuple(
      fc.array(fc.record({ millis: fc.integer({ min: 0, max: 999 }), value: fc.integer() }), {
        maxLength: 60,
      }),
      fc.integer({ min: 1, max: 40 })
    )
    .map(([drafts, bucketCount]) =>
      Buckets.of(
        drafts.map(({ millis, value }) => ({ time: DateTime.unsafeMake(millis), value })),
        [DateTime.unsafeMake(0), DateTime.unsafeMake(999)],
        bucketCount
      )
    )

  test('passes through every bucket middle at its mean, in time order', () => {
    fc.assert(
      fc.property(bucketsArb, (buckets) => {
        const vertices = bucketVertices(axis, buckets)
        const times = vertices.map((vertex) => vertex.time.getTime())
        expect(times).toEqual(times.toSorted((left, right) => left - right))
        for (const bucket of buckets) {
          expect(
            vertices.some(
              (vertex) =>
                vertex.time.getTime() === bucket.time.epochMillis &&
                vertex.mean === ValueAxis.normalise(bucket.mean, axis.domain)
            )
          ).toBe(true)
        }
      }),
      { numRuns: PURE_RUNS }
    )
  })

  test('breaks across a left-out slice and nowhere else', () => {
    fc.assert(
      fc.property(bucketsArb, (buckets) => {
        const vertices = bucketVertices(axis, buckets)
        const breaks = vertices.filter((vertex) => Number.isNaN(vertex.mean)).length
        const gaps = buckets.filter(
          (bucket, index) =>
            index > 0 && buckets[index - 1].end.epochMillis !== bucket.start.epochMillis
        ).length
        expect(breaks).toBe(gaps)
        // Every run, even one bucket alone, spans its slices with at least two vertices.
        const runs = vertices
          .map((vertex) => (Number.isNaN(vertex.mean) ? '|' : '.'))
          .join('')
          .split('|')
          .filter((run) => run.length > 0)
        expect(runs).toHaveLength(buckets.length === 0 ? 0 : gaps + 1)
        for (const run of runs) expect(run.length).toBeGreaterThanOrEqual(2)
      }),
      { numRuns: PURE_RUNS }
    )
  })
})
