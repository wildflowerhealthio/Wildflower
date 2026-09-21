import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  AXIS_CAP,
  type Domain,
  assignAxes,
  denormalise,
  domainFor,
  niceDomain,
  normalise,
  ticksFor,
} from './axis-assignment.ts'
import {
  type MedicationSeries,
  type ObservationSeries,
  type Series,
  type SeriesPoint,
  isObservationSeries,
} from './series.ts'

const RUNS = numRunsFor({ base: 200 })

const finite = fc.double({ min: -1e9, max: 1e9, noNaN: true })
const instant = fc.integer({ min: 0, max: 4e12 }).map((millis) => DateTime.unsafeMake(millis))

const pointArb: fc.Arbitrary<SeriesPoint> = fc
  .record({
    time: instant,
    value: finite,
    bounds: fc.option(fc.tuple(finite, finite), { nil: null }),
  })
  .map(({ time, value, bounds }) =>
    bounds === null
      ? { time, value }
      : { time, value, low: Math.min(...bounds), high: Math.max(...bounds) }
  )

const observationSeries = (
  points: readonly SeriesPoint[],
  kind: ObservationSeries['kind'] = 'quantity'
): ObservationSeries => ({
  key: { kind: 'observation', system: null, code: 'code', unit: 'u' },
  label: 'Label',
  unit: 'u',
  category: null,
  points,
  kind,
})

const medicationSeries = (doses: readonly number[]): MedicationSeries => ({
  key: { kind: 'medication', name: 'insulin', unit: 'mg' },
  label: 'Insulin',
  unit: 'mg',
  segments: doses.map((dose, index) => ({
    start: DateTime.unsafeMake(index * 86_400_000),
    end: null,
    dose,
    perDay: true,
    status: 'active',
    dashed: false,
    requestId: `req-${index}`,
  })),
})

// Doses are non-negative magnitudes — the assumption `domainFor` anchors a
// dose axis at zero on, so generating negatives here would test a shape the
// dose mapping cannot produce.
const dose = fc.double({ min: 0, max: 1e6, noNaN: true })

const seriesArb: fc.Arbitrary<Series> = fc.oneof(
  fc.array(pointArb, { maxLength: 12 }).map((points) => observationSeries(points)),
  fc.array(dose, { maxLength: 6 }).map(medicationSeries)
)

describe('assignAxes', () => {
  test('one slot per input, in order, with sides alternating left/right', () => {
    fc.assert(
      fc.property(fc.array(seriesArb, { minLength: 1, maxLength: AXIS_CAP }), (selected) => {
        const slots = assignAxes(selected)
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
      fc.property(fc.array(seriesArb, { minLength: 1, maxLength: AXIS_CAP }), (selected) => {
        for (const side of ['left', 'right'] as const) {
          const indices = assignAxes(selected)
            .filter((slot) => slot.side === side)
            .map((slot) => slot.index)
          expect(indices).toEqual(indices.map((_, position) => position))
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('a selection beyond AXIS_CAP is rejected rather than quietly truncated', () => {
    fc.assert(
      fc.property(
        fc.array(seriesArb, { minLength: AXIS_CAP + 1, maxLength: AXIS_CAP + 4 }),
        (selected) => {
          expect(() => assignAxes(selected)).toThrow(/at most 4/)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('an empty selection yields no slots', () => {
    expect(assignAxes([])).toEqual([])
  })
})

describe('domainFor', () => {
  test("every one of a series' own values normalises into [0, 1]", () => {
    fc.assert(
      fc.property(seriesArb, (series) => {
        const domain = domainFor(series)
        // Through `isObservationSeries`, not `series.key.kind`: the
        // discriminant is nested one level down, so TypeScript does not narrow
        // the union on it — which is why the guard is exported at all.
        const values: readonly (number | undefined)[] = isObservationSeries(series)
          ? series.points.flatMap((point) => [point.value, point.low, point.high])
          : series.segments.map((segment) => segment.dose)
        for (const value of values) {
          if (value === undefined) continue
          const fraction = normalise(value, domain)
          expect(fraction).toBeGreaterThanOrEqual(0)
          expect(fraction).toBeLessThanOrEqual(1)
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('a boolean series is pinned to [0, 1] whatever its points say', () => {
    expect(
      domainFor(observationSeries([{ time: DateTime.unsafeMake(0), value: 1 }], 'boolean'))
    ).toEqual([0, 1])
  })

  test('a dose axis starts at zero, so a change is read against nothing', () => {
    fc.assert(
      fc.property(fc.array(dose, { minLength: 1, maxLength: 6 }), (doses) => {
        const [low, high] = domainFor(medicationSeries(doses))
        expect(low).toBe(0)
        expect(high).toBeGreaterThan(0)
        expect(high).toBeGreaterThanOrEqual(Math.max(...doses))
      }),
      { numRuns: RUNS }
    )
  })

  test('a series with no data still gets a drawable domain', () => {
    expect(domainFor(observationSeries([]))).toEqual([0, 1])
    expect(domainFor(medicationSeries([]))).toEqual([0, 1])
  })

  test('identical values open into an interval rather than collapsing', () => {
    fc.assert(
      fc.property(finite, (value) => {
        const [low, high] = domainFor(
          observationSeries([
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

describe('normalise / denormalise', () => {
  // An axis a chart could actually draw: a finite low and a width wide enough
  // that dividing by it stays finite. A domain of two adjacent denormals is
  // not a scale, and pretending to round-trip through one proves nothing.
  const domainArb: fc.Arbitrary<Domain> = fc
    .tuple(
      fc.double({ min: -1e6, max: 1e6, noNaN: true }),
      fc.double({ min: 1e-6, max: 1e9, noNaN: true })
    )
    .map(([low, width]): Domain => [low, low + width])

  test('denormalise inverts normalise for values on and around the axis', () => {
    fc.assert(
      fc.property(
        domainArb,
        fc.double({ min: -0.2, max: 1.2, noNaN: true }),
        (domain, fraction) => {
          const value = denormalise(fraction, domain)
          const round = denormalise(normalise(value, domain), domain)
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
          const round = normalise(denormalise(fraction, domain), domain)
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
        expect(normalise(domain[0], domain)).toBe(0)
        expect(normalise(domain[1], domain)).toBe(1)
      }),
      { numRuns: RUNS }
    )
  })

  test('a collapsed domain normalises to 0 instead of dividing by zero', () => {
    expect(normalise(7, [7, 7])).toBe(0)
  })
})

describe('ticksFor', () => {
  test('ticks are ascending and inside the domain', () => {
    fc.assert(
      fc.property(seriesArb, (series) => {
        const domain = domainFor(series)
        const ticks = ticksFor(domain)
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
        const domain = niceDomain(0, 100, count)
        expect(ticksFor(domain, count).length).toBeGreaterThanOrEqual(2)
      }),
      { numRuns: RUNS }
    )
  })

  test('round numbers come out round', () => {
    expect(ticksFor([0, 100], 5)).toEqual([0, 20, 40, 60, 80, 100])
  })
})

describe('niceDomain', () => {
  test('the result always contains the input interval', () => {
    fc.assert(
      fc.property(finite, finite, (left, right) => {
        const low = Math.min(left, right)
        const high = Math.max(left, right)
        const [niceLow, niceHigh] = niceDomain(low, high, 5)
        expect(niceLow).toBeLessThanOrEqual(low)
        expect(niceHigh).toBeGreaterThanOrEqual(high)
      }),
      { numRuns: RUNS }
    )
  })
})
