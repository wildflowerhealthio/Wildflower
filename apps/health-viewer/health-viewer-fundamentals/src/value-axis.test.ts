import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
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

const fromZeroSeries = (values: readonly number[]): Series.Series =>
  levelSeriesOf(values.map((value, index) => levelFrom(index * 86_400_000, null, value)))

const seriesArb: fc.Arbitrary<Series.Series> = fc.oneof(
  fc.array(pointArb, { maxLength: 12 }).map((points) => pointSeriesOf(points)),
  fc.array(magnitude, { maxLength: 6 }).map(fromZeroSeries)
)

describe('ValueAxis.assign', () => {
  test('one slot per input, in order, with sides alternating left/right', () => {
    fc.assert(
      fc.property(fc.array(seriesArb, { minLength: 1, maxLength: ValueAxis.CAP }), (selected) => {
        const slots = ValueAxis.assign(selected)
        expect(slots).toHaveLength(selected.length)
        expect(slots.map((slot) => slot.series)).toEqual(selected)
        expect(slots.map((slot) => slot.side)).toEqual(
          selected.map((_, position) => (position % 2 === 0 ? 'left' : 'right'))
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('index counts up within a side, so no two axes on one side collide', () => {
    fc.assert(
      fc.property(fc.array(seriesArb, { minLength: 1, maxLength: ValueAxis.CAP }), (selected) => {
        for (const side of ['left', 'right'] as const) {
          const indices = ValueAxis.assign(selected)
            .filter((slot) => slot.side === side)
            .map((slot) => slot.index)
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

  test('an empty selection yields no slots', () => {
    expect(ValueAxis.assign([])).toEqual([])
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

  test('a requested count lands within one of the tick interval count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10 }), (count) => {
        const domain = ValueAxis.niceDomain(0, 100, count)
        expect(ValueAxis.ticksFor(domain, count).length).toBeGreaterThanOrEqual(2)
      }),
      { numRuns: RUNS }
    )
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
