import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { levelFrom, levelSeriesOf, pointArb, pointSeriesOf } from './arbitraries.test-helpers.ts'
import type * as Series from './series.ts'
import * as ValueAxis from './value-axis.ts'

const RUNS = numRunsFor({ base: 200 })

const finite = fc.double({ min: -1e9, max: 1e9, noNaN: true })

// Level values under `'from-zero'` are non-negative magnitudes — the
// assumption that scale anchors at zero on — so generating negatives here
// would test a shape no domain maps to it.
const magnitude = fc.double({ min: 0, max: 1e6, noNaN: true })

const fromZeroSeries = (values: readonly number[]): Series.ValueSeries =>
  levelSeriesOf(values.map((value, index) => levelFrom(index * 86_400_000, null, value)))

/** `series` drawn from zero, as a dose is. */
const asFromZero = (series: Series.ValueSeries): Series.ValueSeries => ({
  ...series,
  valueScale: 'from-zero',
})

const seriesArb: fc.Arbitrary<Series.ValueSeries> = fc.oneof(
  fc.array(pointArb, { maxLength: 12 }).map((points) => pointSeriesOf(points)),
  fc.array(magnitude, { maxLength: 6 }).map(fromZeroSeries)
)

/** `series` under its own id and unit, so no two of a selection share an axis by accident. */
const withOwnUnit = (series: Series.ValueSeries, position: number): Series.ValueSeries => ({
  ...series,
  id: `s${position}`,
  unit: `unit ${position}`,
})

/** A selection of up to `ValueAxis.CAP` series, each in a unit of its own. */
const distinctUnitSelectionArb = fc
  .array(seriesArb, { minLength: 1, maxLength: ValueAxis.CAP })
  .map((selected) => selected.map(withOwnUnit))

/**
 * Readings within half again of a level between 20 and 200, so two of them
 * are often within `ValueAxis.MAX_SHARED_RATIO` of each other and share an
 * axis, and sometimes are not.
 */
const similarRangeArb: fc.Arbitrary<Series.ValueSeries> = fc
  .tuple(
    fc.double({ min: 20, max: 200, noNaN: true }),
    fc.array(fc.double({ min: 1, max: 1.5, noNaN: true }), { minLength: 1, maxLength: 8 })
  )
  .map(([level, factors]) =>
    pointSeriesOf(
      factors.map((factor, index) => ({ time: DateTime.unsafeMake(index), value: level * factor }))
    )
  )

/**
 * A selection of up to `ValueAxis.CAP` series whose units collide often —
 * including `null` — and whose value scales mix, so axes are shared in every
 * way {@link ValueAxis.assign} allows.
 */
const mixedSelectionArb = fc
  .array(
    fc.record({
      series: fc.oneof(
        seriesArb,
        { arbitrary: similarRangeArb, weight: 2 },
        similarRangeArb.map(asFromZero)
      ),
      unit: fc.constantFrom<string | null>('u', 'v', null),
      // One in four, so the fitted and from-zero series are most of a selection.
      zeroToOne: fc.nat(3).map((draw) => draw === 0),
    }),
    { minLength: 1, maxLength: ValueAxis.CAP }
  )
  .map((drafts) =>
    drafts.map(({ series, unit, zeroToOne }, position): Series.ValueSeries => ({
      ...series,
      id: `s${position}`,
      unit,
      ...(zeroToOne ? { valueScale: 'zero-to-one' as const } : {}),
    }))
  )

/** Every value and band bound `series` plots. */
const plottedValuesOf = (series: Series.ValueSeries): readonly number[] =>
  (series.kind === 'points' ? series.points : series.levels).flatMap((mark) =>
    [mark.value, mark.low, mark.high].filter((value) => value !== undefined)
  )

/** A point series `id` in `unit` with one reading per value, a day apart. */
const readingsOf = (
  id: string,
  unit: string | null,
  values: readonly number[],
  valueScale: Series.ValueScale = 'fitted'
): Series.ValueSeries => ({
  ...pointSeriesOf(
    values.map((value, index) => ({ time: DateTime.unsafeMake(index * 86_400_000), value })),
    valueScale
  ),
  id,
  unit,
})

/** Each axis' series ids, in axis order. */
const seriesIdsByAxis = (axes: readonly ValueAxis.ValueAxis[]): readonly (readonly string[])[] =>
  axes.map((axis) => axis.series.map((series) => series.id))

describe('ValueAxis.assign', () => {
  test('series in units of their own get one axis each, in order, with sides alternating left/right', () => {
    fc.assert(
      fc.property(distinctUnitSelectionArb, (selected) => {
        const axes = ValueAxis.assign(selected)
        expect(axes.map((axis) => axis.series)).toEqual(selected.map((series) => [series]))
        expect(axes.map((axis) => axis.side)).toEqual(
          selected.map((_, position) => (position % 2 === 0 ? 'left' : 'right'))
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('every series is on exactly one axis, axes in the selection order of their first series', () => {
    fc.assert(
      fc.property(mixedSelectionArb, (selected) => {
        const axes = ValueAxis.assign(selected)
        const positionOf = (series: Series.ValueSeries): number => selected.indexOf(series)
        const placed = axes.flatMap((axis) => axis.series)
        expect(placed.toSorted((left, right) => positionOf(left) - positionOf(right))).toEqual(
          selected
        )
        for (const axis of axes) {
          const positions = axis.series.map(positionOf)
          expect(positions).toEqual(positions.toSorted((left, right) => left - right))
        }
        const firstPositions = axes.map((axis) => positionOf(axis.series[0]))
        expect(firstPositions).toEqual(firstPositions.toSorted((left, right) => left - right))
        expect(axes.map((axis) => axis.side)).toEqual(
          axes.map((_, position) => (position % 2 === 0 ? 'left' : 'right'))
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('a shared axis names its one non-null unit, holds one kind of scale, and values of a similar magnitude', () => {
    fc.assert(
      fc.property(mixedSelectionArb, (selected) => {
        for (const axis of ValueAxis.assign(selected)) {
          if (axis.series.length === 1) {
            expect(axis.sharedUnit).toBeNull()
            continue
          }
          const [first] = axis.series
          expect(first.unit).not.toBeNull()
          expect(axis.sharedUnit).toBe(first.unit)
          const isZeroToOne = first.valueScale === 'zero-to-one'
          for (const series of axis.series) {
            expect(series.unit).toBe(first.unit)
            expect(series.valueScale === 'zero-to-one').toBe(isZeroToOne)
            expect(plottedValuesOf(series).length).toBeGreaterThan(0)
          }
          if (isZeroToOne) continue
          const extents = axis.series.map((series) => {
            const values = plottedValuesOf(series)
            return { series, low: Math.min(...values), high: Math.max(...values) }
          })
          const sharedHigh = Math.max(...extents.map(({ high }) => high))
          const sharedLow = Math.min(...extents.map(({ low }) => low))
          for (const { series, low } of extents) {
            if (series.valueScale === 'fitted') expect(low).toBeGreaterThan(0)
          }
          if (axis.series.some((series) => series.valueScale === 'from-zero')) {
            expect(axis.domain[0]).toBe(0)
            for (const { high } of extents) {
              expect(high * ValueAxis.MAX_SHARED_RATIO).toBeGreaterThanOrEqual(sharedHigh)
            }
          } else {
            expect(sharedHigh).toBeLessThanOrEqual(sharedLow * ValueAxis.MAX_SHARED_RATIO)
          }
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('an axis of one series spans what that series alone would', () => {
    fc.assert(
      fc.property(mixedSelectionArb, (selected) => {
        for (const axis of ValueAxis.assign(selected)) {
          if (axis.series.length === 1) {
            expect(axis.domain).toEqual(ValueAxis.domainFor(axis.series[0]))
          }
        }
      }),
      { numRuns: RUNS }
    )
  })

  test("every one of an axis' series' values normalises into [0, 1]", () => {
    fc.assert(
      fc.property(mixedSelectionArb, (selected) => {
        for (const axis of ValueAxis.assign(selected)) {
          if (axis.series.some((series) => series.valueScale === 'zero-to-one')) continue
          for (const series of axis.series) {
            const values: readonly (number | undefined)[] = (
              series.kind === 'points' ? series.points : series.levels
            ).flatMap((mark) => [mark.value, mark.low, mark.high])
            for (const value of values) {
              if (value === undefined) continue
              const fraction = ValueAxis.normalise(value, axis.domain)
              expect(fraction).toBeGreaterThanOrEqual(0)
              expect(fraction).toBeLessThanOrEqual(1)
            }
          }
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('index counts up within a side, so no two axes on one side collide', () => {
    fc.assert(
      fc.property(mixedSelectionArb, (selected) => {
        for (const side of ['left', 'right'] as const) {
          const indices = ValueAxis.assign(selected)
            .filter((axis) => axis.side === side)
            .map((axis) => axis.index)
          expect(indices).toEqual(indices.map((_, position) => position))
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('a selection beyond ValueAxis.CAP is rejected rather than quietly truncated', () => {
    fc.assert(
      fc.property(
        fc.array(seriesArb, { minLength: ValueAxis.CAP + 1, maxLength: ValueAxis.CAP + 4 }),
        (selected) => {
          expect(() => ValueAxis.assign(selected)).toThrow(/at most 4/)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('an empty selection yields no axes', () => {
    expect(ValueAxis.assign([])).toEqual([])
  })

  test('systolic and diastolic blood pressure share one mm[Hg] axis', () => {
    const systolic = readingsOf('systolic', 'mm[Hg]', [118, 135, 142, 125])
    const diastolic = readingsOf('diastolic', 'mm[Hg]', [76, 88, 92, 80])
    const axes = ValueAxis.assign([systolic, diastolic])
    expect(seriesIdsByAxis(axes)).toEqual([['systolic', 'diastolic']])
    expect(axes[0].domain).toEqual([60, 160])
  })

  test('tightly held blood pressure still shares one axis', () => {
    const systolic = readingsOf('systolic', 'mm[Hg]', [120, 126, 130])
    const diastolic = readingsOf('diastolic', 'mm[Hg]', [78, 81, 84])
    expect(seriesIdsByAxis(ValueAxis.assign([systolic, diastolic]))).toEqual([
      ['systolic', 'diastolic'],
    ])
  })

  test('a constant series shares an axis when its value sits among the others', () => {
    const systolic = readingsOf('systolic', 'mm[Hg]', [118, 135, 142, 125])
    const diastolic = readingsOf('diastolic', 'mm[Hg]', [76, 88, 92, 80])
    const target = readingsOf('target', 'mm[Hg]', [120, 120, 120])
    expect(seriesIdsByAxis(ValueAxis.assign([systolic, diastolic, target]))).toEqual([
      ['systolic', 'diastolic', 'target'],
    ])
  })

  test('a constant series far below the others keeps its own axis', () => {
    const systolic = readingsOf('systolic', 'mm[Hg]', [118, 135, 142, 125])
    const low = readingsOf('low', 'mm[Hg]', [5, 5, 5])
    expect(seriesIdsByAxis(ValueAxis.assign([systolic, low]))).toEqual([['systolic'], ['low']])
  })

  test('heart rate and respiratory rate, both per minute, keep their own axes', () => {
    const heartRate = readingsOf('heart-rate', '/min', [60, 72, 100, 85])
    const respiratoryRate = readingsOf('respiratory-rate', '/min', [12, 16, 20, 14])
    expect(seriesIdsByAxis(ValueAxis.assign([heartRate, respiratoryRate]))).toEqual([
      ['heart-rate'],
      ['respiratory-rate'],
    ])
  })

  test('series with no unit never share, however alike', () => {
    const first = readingsOf('first', null, [1, 2, 3])
    const second = readingsOf('second', null, [1, 2, 3])
    expect(seriesIdsByAxis(ValueAxis.assign([first, second]))).toEqual([['first'], ['second']])
  })

  test('a series with no readings keeps its own axis', () => {
    const readings = readingsOf('readings', 'mg', [10, 12])
    const empty = readingsOf('empty', 'mg', [])
    expect(seriesIdsByAxis(ValueAxis.assign([readings, empty]))).toEqual([['readings'], ['empty']])
    expect(seriesIdsByAxis(ValueAxis.assign([empty, readings]))).toEqual([['empty'], ['readings']])
  })

  test("a 'zero-to-one' series shares only with another 'zero-to-one' series", () => {
    const flagged = readingsOf('flagged', '{flag}', [0, 1, 1], 'zero-to-one')
    const alsoFlagged = readingsOf('also-flagged', '{flag}', [1, 0], 'zero-to-one')
    const fraction = readingsOf('fraction', '{flag}', [0.4, 0.5, 1])
    expect(seriesIdsByAxis(ValueAxis.assign([flagged, fraction, alsoFlagged]))).toEqual([
      ['flagged', 'also-flagged'],
      ['fraction'],
    ])
  })

  test("a 'fitted' series shares a 'from-zero' axis, drawn from zero, when its highest is a third of the axis'", () => {
    const dose: Series.ValueSeries = {
      ...levelSeriesOf([levelFrom(0, null, 1000)]),
      id: 'dose',
      unit: 'mg',
    }
    const near = readingsOf('near', 'mg', [880, 890, 900])
    const axes = ValueAxis.assign([near, dose])
    expect(seriesIdsByAxis(axes)).toEqual([['near', 'dose']])
    expect(axes[0].domain[0]).toBe(0)

    const far = readingsOf('far', 'mg', [100, 150, 200])
    expect(seriesIdsByAxis(ValueAxis.assign([far, dose]))).toEqual([['far'], ['dose']])
  })

  test("a 'fitted' series with a value at or below zero never shares, but still gets its own axis", () => {
    const dose: Series.ValueSeries = {
      ...levelSeriesOf([levelFrom(0, null, 100)]),
      id: 'dose',
      unit: 'mg',
    }
    const change = readingsOf('change', 'mg', [-5, 40, 90])
    const fromNothing = readingsOf('from-nothing', 'mg', [0, 40, 90])
    const alike = readingsOf('alike', 'mg', [40, 60, 90])
    expect(seriesIdsByAxis(ValueAxis.assign([change, dose]))).toEqual([['change'], ['dose']])
    expect(seriesIdsByAxis(ValueAxis.assign([fromNothing, alike]))).toEqual([
      ['from-nothing'],
      ['alike'],
    ])
    const [axis] = ValueAxis.assign([change])
    expect(axis.domain).toEqual(ValueAxis.domainFor(change))
  })

  test('a series too far from an axis opens its own, and later ones still join', () => {
    const systolic = readingsOf('systolic', 'mm[Hg]', [118, 135, 142, 125])
    const outlier = readingsOf('outlier', 'mm[Hg]', [1000, 1010])
    const diastolic = readingsOf('diastolic', 'mm[Hg]', [76, 88, 92, 80])
    const axes = ValueAxis.assign([systolic, outlier, diastolic])
    expect(seriesIdsByAxis(axes)).toEqual([['systolic', 'diastolic'], ['outlier']])
    expect(axes.map((axis) => axis.side)).toEqual(['left', 'right'])
  })
})

describe('ValueAxis.domainFor', () => {
  test("every one of a series' own values normalises into [0, 1]", () => {
    fc.assert(
      fc.property(seriesArb, (series) => {
        const domain = ValueAxis.domainFor(series)
        const values: readonly (number | undefined)[] = (
          series.kind === 'points' ? series.points : series.levels
        ).flatMap((mark) => [mark.value, mark.low, mark.high])
        for (const value of values) {
          if (value === undefined) continue
          const fraction = ValueAxis.normalise(value, domain)
          expect(fraction).toBeGreaterThanOrEqual(0)
          expect(fraction).toBeLessThanOrEqual(1)
        }
      }),
      { numRuns: RUNS }
    )
  })

  test("a 'zero-to-one' series is pinned to [0, 1] whatever its values say", () => {
    fc.assert(
      fc.property(fc.array(pointArb, { maxLength: 12 }), (points) => {
        expect(ValueAxis.domainFor(pointSeriesOf(points, 'zero-to-one'))).toEqual([0, 1])
      }),
      { numRuns: RUNS }
    )
  })

  test("a 'from-zero' axis starts at zero, so a change is read against nothing", () => {
    fc.assert(
      fc.property(fc.array(magnitude, { minLength: 1, maxLength: 6 }), (values) => {
        const [low, high] = ValueAxis.domainFor(fromZeroSeries(values))
        expect(low).toBe(0)
        expect(high).toBeGreaterThan(0)
        expect(high).toBeGreaterThanOrEqual(Math.max(...values))
      }),
      { numRuns: RUNS }
    )
  })

  test('a series with no data still gets a drawable domain', () => {
    expect(ValueAxis.domainFor(pointSeriesOf([]))).toEqual([0, 1])
    expect(ValueAxis.domainFor(fromZeroSeries([]))).toEqual([0, 1])
  })

  test('identical values open into an interval rather than collapsing', () => {
    fc.assert(
      fc.property(finite, (value) => {
        const [low, high] = ValueAxis.domainFor(
          pointSeriesOf([
            { time: DateTime.unsafeMake(0), value },
            { time: DateTime.unsafeMake(1), value },
          ])
        )
        expect(high).toBeGreaterThan(low)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('ValueAxis.normalise / denormalise', () => {
  // An axis a chart could actually draw: a finite low and a width wide enough
  // that dividing by it stays finite. A domain of two adjacent denormals is
  // not a scale, and pretending to round-trip through one proves nothing.
  const domainArb: fc.Arbitrary<ValueAxis.Domain> = fc
    .tuple(
      fc.double({ min: -1e6, max: 1e6, noNaN: true }),
      fc.double({ min: 1e-6, max: 1e9, noNaN: true })
    )
    .map(([low, width]): ValueAxis.Domain => [low, low + width])

  test('denormalise inverts normalise for values on and around the axis', () => {
    fc.assert(
      fc.property(
        domainArb,
        fc.double({ min: -0.2, max: 1.2, noNaN: true }),
        (domain, fraction) => {
          const value = ValueAxis.denormalise(fraction, domain)
          const round = ValueAxis.denormalise(ValueAxis.normalise(value, domain), domain)
          const tolerance = Math.max(Math.abs(value), domain[1] - domain[0]) * 1e-9
          expect(Math.abs(round - value)).toBeLessThanOrEqual(tolerance)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('normalise inverts denormalise', () => {
    fc.assert(
      fc.property(
        domainArb,
        fc.double({ min: -0.2, max: 1.2, noNaN: true }),
        (domain, fraction) => {
          const round = ValueAxis.normalise(ValueAxis.denormalise(fraction, domain), domain)
          // Relative to the magnitudes involved: `denormalise` adds the domain's
          // low, so a wide axis with a large offset loses absolute precision,
          // and a fixed epsilon would be seed-dependent rather than wrong.
          const scale = Math.max(1, Math.abs(domain[0]) / (domain[1] - domain[0]))
          expect(Math.abs(round - fraction)).toBeLessThanOrEqual(scale * 1e-9)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('the domain bounds map to the unit interval bounds', () => {
    fc.assert(
      fc.property(domainArb, (domain) => {
        expect(ValueAxis.normalise(domain[0], domain)).toBe(0)
        expect(ValueAxis.normalise(domain[1], domain)).toBe(1)
      }),
      { numRuns: RUNS }
    )
  })

  test('a collapsed domain normalises to 0 instead of dividing by zero', () => {
    expect(ValueAxis.normalise(7, [7, 7])).toBe(0)
  })
})

describe('ValueAxis.ticksFor', () => {
  test('ticks are ascending and inside the domain', () => {
    fc.assert(
      fc.property(seriesArb, (series) => {
        const domain = ValueAxis.domainFor(series)
        const ticks = ValueAxis.ticksFor(domain)
        expect(ticks.length).toBeGreaterThan(0)
        for (const tick of ticks) {
          expect(tick).toBeGreaterThanOrEqual(domain[0])
          expect(tick).toBeLessThanOrEqual(domain[1])
        }
        expect(ticks).toEqual(ticks.toSorted((left, right) => left - right))
      }),
      { numRuns: RUNS }
    )
  })

  test('an axis niceDomain rounded is labelled at both its ends', () => {
    fc.assert(
      fc.property(
        finite,
        fc.double({ min: 1e-3, max: 1e6, noNaN: true }),
        fc.integer({ min: 2, max: 10 }),
        (low, width, count) => {
          const domain = ValueAxis.niceDomain(low, low + width, count)
          const ticks = ValueAxis.ticksFor(domain, count)
          expect(ticks[0]).toBe(domain[0] + 0)
          expect(ticks.at(-1)).toBe(domain[1] + 0)
          expect(ticks.length - 1).toBeLessThanOrEqual(2 * count)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('an all-negative axis niceDomain rounded is labelled at both its ends, in whole steps', () => {
    fc.assert(
      fc.property(
        // A drawable all-negative axis: `low` below zero, and a width that is
        // a real fraction of its magnitude, so `high` stays at or below zero.
        fc.double({ min: 1e-3, max: 1e6, noNaN: true }),
        fc.double({ min: 1e-3, max: 1, noNaN: true }),
        fc.integer({ min: 2, max: 10 }),
        (lowMagnitude, widthFraction, count) => {
          const low = -lowMagnitude
          const high = low + lowMagnitude * widthFraction
          const domain = ValueAxis.niceDomain(low, high, count)
          const ticks = ValueAxis.ticksFor(domain, count)
          expect(ticks[0]).toBe(domain[0] + 0)
          expect(ticks.at(-1)).toBe(domain[1] + 0)
          const step = ticks[1] - ticks[0]
          for (const [index, tick] of ticks.entries()) {
            if (index > 0) expect(tick).toBeGreaterThan(ticks[index - 1])
            const stepsFromZero = tick / step
            const roundingError = Math.abs(stepsFromZero - Math.round(stepsFromZero))
            expect(roundingError).toBeLessThan(Math.max(1, Math.abs(stepsFromZero)) * 1e-9)
          }
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('an all-negative axis is labelled at both its ends', () => {
    expect(ValueAxis.ticksFor([-80, -40])).toEqual([-80, -70, -60, -50, -40])
  })

  test('a negative bound half a step off a tick is not snapped onto one', () => {
    // `-125` is `-2.5` steps of `50`, which `Math.round` takes to `-2`.
    expect(ValueAxis.ticksFor([-125, 0])).toEqual([-100, -50, 0])
  })

  test('a step too coarse for the bounds gives way to a finer one that meets them', () => {
    expect(ValueAxis.ticksFor([-40, 80])).toEqual([-40, -20, 0, 20, 40, 60, 80])
  })

  test('round numbers come out round', () => {
    expect(ValueAxis.ticksFor([0, 100], 5)).toEqual([0, 20, 40, 60, 80, 100])
  })

  test('a zero tick is never negative zero', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: -1e-6, noNaN: true }), finite, (low, span) => {
        const ticks = ValueAxis.ticksFor([low, low + Math.abs(span) + 1])
        expect(ticks.some((tick) => Object.is(tick, -0))).toBe(false)
      }),
      { numRuns: RUNS }
    )
    expect(Object.is(ValueAxis.ticksFor([-10, 10], 4)[2], 0)).toBe(true)
  })

  const expectBoundedAscendingTicksInside = (domain: ValueAxis.Domain, count: number): void => {
    const ticks = ValueAxis.ticksFor(domain, count)
    // At most `MAX_TICKS + 1`, the module's unexported ceiling of 64 intervals.
    expect(ticks.length).toBeLessThanOrEqual(65)
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(domain[0])
      expect(tick).toBeLessThanOrEqual(domain[1])
    }
    expect(ticks).toEqual(ticks.toSorted((left, right) => left - right))
  }

  test('any finite domain gets a bounded set of ascending ticks inside it', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 2, max: 10 }),
        (first, second, count) => {
          expectBoundedAscendingTicksInside(
            [Math.min(first, second), Math.max(first, second)],
            count
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('a hairline domain at large magnitude gets a bounded set of ascending ticks inside it', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e8, max: 1e15, noNaN: true }),
        fc.double({ min: 1e-16, max: 1e-12, noNaN: true }),
        fc.integer({ min: 2, max: 10 }),
        (low, widthFraction, count) => {
          expectBoundedAscendingTicksInside([low, low + low * widthFraction], count)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('a hairline domain past safe-integer step counts is labelled at its ends', () => {
    expect(ValueAxis.ticksFor([900719925.4740982, 900719925.4740992], 10)).toEqual([
      900719925.4740982, 900719925.4740992,
    ])
  })
})

describe('ValueAxis.niceDomain', () => {
  test('the result always contains the input interval', () => {
    fc.assert(
      fc.property(finite, finite, (left, right) => {
        const low = Math.min(left, right)
        const high = Math.max(left, right)
        const [niceLow, niceHigh] = ValueAxis.niceDomain(low, high, 5)
        expect(niceLow).toBeLessThanOrEqual(low)
        expect(niceHigh).toBeGreaterThanOrEqual(high)
      }),
      { numRuns: RUNS }
    )
  })
})
