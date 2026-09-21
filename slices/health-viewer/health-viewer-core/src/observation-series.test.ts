import { Arbitrary, DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { Code, CodeableConcept, Period, type Quantity } from 'fhir-r4/data-types'
import { Observation } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { EXCLUDED_STATUSES, LOINC_SYSTEM, observationsToSeries } from './observation-series.ts'
import { seriesId } from './series.ts'

const RUNS = numRunsFor({ base: 100 })

/**
 * A decoded Observation carrying nothing, for overrides to be spread onto.
 *
 * @remarks
 * Decoded from the minimal wire resource rather than hand-written, so the
 * schema's own defaults fill every slot and the shell cannot drift from the
 * resource it stands in for.
 *
 * Generating a whole Observation instead would walk the Reference → Identifier
 * cycle and every `value[x]` variant per iteration — and the choice slots'
 * arbitraries are pinned to `null` anyway, so a generated resource carries no
 * value at all. Each property below generates only the fields it is about,
 * from the same component schemas the resource embeds.
 */
const shell: typeof Observation.Schema.Type = Schema.decodeUnknownSync(Observation.Schema)({
  resourceType: 'Observation',
  id: 'obs-id',
  status: 'final',
  code: { coding: [], text: 'Glucose' },
})

/** A full `Quantity`, so a test states a value rather than hoping one generates. */
const quantity = (value: number, unit: string | null, code: string | null): Quantity.Type => ({
  id: null,
  extension: [],
  code: code === null ? null : Code.make(code),
  comparator: null,
  system: null,
  unit,
  value,
})

/** A `CodeableConcept` with one coding, the shape real observations carry. */
const concept = (
  system: string | null,
  code: string,
  text: string | null
): typeof CodeableConcept.Schema.Type => ({
  id: null,
  extension: [],
  coding: [
    {
      id: null,
      extension: [],
      code: Code.make(code),
      display: null,
      system: system === null ? null : new URL(system),
      userSelected: null,
      version: null,
    },
  ],
  text,
})

const at = (iso: string): DateTime.Utc => DateTime.unsafeMake(iso)

const instantArb = Arbitrary.make(Schema.DateTimeUtc)
const periodArb = Arbitrary.make(Period.Schema)
const statusArb = Arbitrary.make(Observation.StatusSchema)

describe('observationsToSeries', () => {
  describe('effective-time precedence', () => {
    const slots = fc.record({
      effectiveDateTime: fc.option(instantArb, { nil: null }),
      effectivePeriod: fc.option(periodArb, { nil: null }),
      effectiveInstant: fc.option(instantArb, { nil: null }),
      issued: fc.option(instantArb, { nil: null }),
    })

    test("every point's time is the highest-precedence slot its source carried", () => {
      fc.assert(
        fc.property(slots, (times) => {
          const observation = { ...shell, ...times, valueQuantity: quantity(5, 'mmol/L', null) }
          const expected =
            times.effectiveDateTime ??
            times.effectivePeriod?.start ??
            times.effectiveInstant ??
            times.issued ??
            null
          const { series, undated } = observationsToSeries([observation])
          if (expected === null) {
            expect(series).toEqual([])
            expect(undated).toBe(1)
          } else {
            expect(series).toHaveLength(1)
            expect(series[0].points).toEqual([{ time: expected, value: 5 }])
          }
        }),
        { numRuns: RUNS }
      )
    })

    test('a period without a start falls through to the next slot, it does not win empty', () => {
      const issued = at('2024-03-01T00:00:00Z')
      const { series } = observationsToSeries([
        {
          ...shell,
          effectivePeriod: {
            id: null,
            extension: [],
            start: null,
            end: at('2024-06-01T00:00:00Z'),
          },
          issued,
          valueQuantity: quantity(5, 'mmol/L', null),
        },
      ])
      expect(series[0].points[0].time).toEqual(issued)
    })
  })

  describe('status filter', () => {
    test('an excluded status never produces a point, any other status always does', () => {
      fc.assert(
        fc.property(statusArb, instantArb, (status, time) => {
          const { series, dropped } = observationsToSeries([
            { ...shell, status, effectiveDateTime: time, valueQuantity: quantity(1, 'mg', null) },
          ])
          if (EXCLUDED_STATUSES.has(status)) {
            expect(series).toEqual([])
            expect(dropped).toBe(1)
          } else {
            expect(series).toHaveLength(1)
            expect(dropped).toBe(0)
          }
        }),
        { numRuns: RUNS }
      )
    })

    test('the excluded set is exactly the two FHIR "never happened" statuses', () => {
      expect([...EXCLUDED_STATUSES].toSorted()).toEqual(['cancelled', 'entered-in-error'])
    })
  })

  describe('components', () => {
    const componentOf = (
      code: string,
      text: string,
      value: number
    ): (typeof shell.component)[number] => ({
      id: null,
      extension: [],
      modifierExtension: [],
      code: concept(LOINC_SYSTEM, code, text),
      dataAbsentReason: null,
      interpretation: [],
      referenceRange: [],
      valueQuantity: quantity(value, 'mmHg', null),
      valueCodeableConcept: null,
      valueString: null,
      valueBoolean: null,
      valueInteger: null,
      valueRange: null,
      valueRatio: null,
      valueSampledData: null,
      valueTime: null,
      valueDateTime: null,
      valuePeriod: null,
    })

    test('one series per distinct component code, however many observations carry them', () => {
      const codes = fc.uniqueArray(fc.stringMatching(/^[0-9]{4}-[0-9]$/), {
        minLength: 1,
        maxLength: 4,
      })
      fc.assert(
        fc.property(
          codes,
          fc.array(instantArb, { minLength: 1, maxLength: 5 }),
          (codeSet, times) => {
            const observations = times.map((time) => ({
              ...shell,
              code: concept(null, 'panel', 'Blood pressure'),
              effectiveDateTime: time,
              component: codeSet.map((code, index) =>
                componentOf(code, `Part ${index}`, index + 1)
              ),
            }))
            const { series } = observationsToSeries(observations)
            expect(series).toHaveLength(codeSet.length)
            expect(
              series.map((entry) => entry.key.kind === 'observation' && entry.key.code)
            ).toEqual(codeSet)
            for (const entry of series) expect(entry.points).toHaveLength(times.length)
          }
        ),
        { numRuns: RUNS }
      )
    })

    test("a component's label names the observation and the component", () => {
      const { series } = observationsToSeries([
        {
          ...shell,
          code: concept(null, 'panel', 'Blood pressure'),
          effectiveDateTime: at('2024-01-01T00:00:00Z'),
          component: [componentOf('8480-6', 'Systolic', 120)],
        },
      ])
      expect(series[0].label).toBe('Blood pressure · Systolic')
    })

    test('a top-level value and components both plot, neither is swallowed', () => {
      const { series } = observationsToSeries([
        {
          ...shell,
          code: concept(null, 'panel', 'Blood pressure'),
          effectiveDateTime: at('2024-01-01T00:00:00Z'),
          valueQuantity: quantity(93, 'mmHg', null),
          component: [componentOf('8480-6', 'Systolic', 120)],
        },
      ])
      expect(series.map((entry) => entry.label)).toEqual([
        'Blood pressure',
        'Blood pressure · Systolic',
      ])
    })
  })

  describe('series identity', () => {
    test('output series keys are unique', () => {
      const observationArb = fc.record({
        code: Arbitrary.make(CodeableConcept.Schema),
        effectiveDateTime: instantArb,
        value: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        unit: fc.option(fc.string({ maxLength: 4 }), { nil: null }),
      })
      fc.assert(
        fc.property(fc.array(observationArb, { maxLength: 6 }), (specs) => {
          const { series } = observationsToSeries(
            specs.map((spec) => ({
              ...shell,
              code: spec.code,
              effectiveDateTime: spec.effectiveDateTime,
              valueQuantity: quantity(spec.value, spec.unit, null),
            }))
          )
          const ids = series.map((entry) => seriesId(entry.key))
          expect(new Set(ids).size).toBe(ids.length)
        }),
        { numRuns: RUNS }
      )
    })

    test('the same code in two units is two series', () => {
      const { series } = observationsToSeries([
        {
          ...shell,
          code: concept(LOINC_SYSTEM, '2339-0', 'Glucose'),
          effectiveDateTime: at('2024-01-01T00:00:00Z'),
          valueQuantity: quantity(5.4, 'mmol/L', null),
        },
        {
          ...shell,
          code: concept(LOINC_SYSTEM, '2339-0', 'Glucose'),
          effectiveDateTime: at('2024-02-01T00:00:00Z'),
          valueQuantity: quantity(97, 'mg/dL', null),
        },
      ])
      expect(series.map((entry) => entry.unit)).toEqual(['mmol/L', 'mg/dL'])
    })

    test('a LOINC coding is preferred over an earlier one from another system', () => {
      const code: typeof CodeableConcept.Schema.Type = {
        id: null,
        extension: [],
        coding: [
          ...concept('http://example.test/local', 'GLU', null).coding,
          ...concept(LOINC_SYSTEM, '2339-0', null).coding,
        ],
        text: 'Glucose',
      }
      const { series } = observationsToSeries([
        {
          ...shell,
          code,
          effectiveDateTime: at('2024-01-01T00:00:00Z'),
          valueQuantity: quantity(5.4, 'mmol/L', null),
        },
      ])
      expect(series[0].key).toEqual({
        kind: 'observation',
        system: LOINC_SYSTEM,
        code: '2339-0',
        unit: 'mmol/L',
      })
    })

    test('a concept with no coding keys off its text, with a null system', () => {
      const { series } = observationsToSeries([
        {
          ...shell,
          code: { id: null, extension: [], coding: [], text: 'Home glucose' },
          effectiveDateTime: at('2024-01-01T00:00:00Z'),
          valueQuantity: quantity(5.4, null, null),
        },
      ])
      expect(series[0].key).toEqual({
        kind: 'observation',
        system: null,
        code: 'Home glucose',
        unit: null,
      })
    })
  })

  describe('values', () => {
    test("a quantity's unit falls back to its UCUM code", () => {
      const { series } = observationsToSeries([
        {
          ...shell,
          effectiveDateTime: at('2024-01-01T00:00:00Z'),
          valueQuantity: quantity(5.4, null, 'mmol/L'),
        },
      ])
      expect(series[0].unit).toBe('mmol/L')
      expect(series[0].kind).toBe('quantity')
    })

    test('an integer and a boolean plot as numbers, with their own kinds', () => {
      const { series } = observationsToSeries([
        {
          ...shell,
          code: concept(null, 'count', 'Step count'),
          effectiveDateTime: at('2024-01-01T00:00:00Z'),
          valueInteger: 4200,
        },
        {
          ...shell,
          code: concept(null, 'smoker', 'Smoker'),
          effectiveDateTime: at('2024-01-01T00:00:00Z'),
          valueBoolean: true,
        },
        {
          ...shell,
          code: concept(null, 'smoker', 'Smoker'),
          effectiveDateTime: at('2024-02-01T00:00:00Z'),
          valueBoolean: false,
        },
      ])
      expect(series.map((entry) => [entry.kind, entry.points.map((point) => point.value)])).toEqual(
        [
          ['integer', [4200]],
          ['boolean', [1, 0]],
        ]
      )
    })

    test('a non-numeric value contributes nothing and is counted as dropped', () => {
      const { series, dropped, undated } = observationsToSeries([
        { ...shell, effectiveDateTime: at('2024-01-01T00:00:00Z'), valueString: 'negative' },
      ])
      expect(series).toEqual([])
      expect(dropped).toBe(1)
      expect(undated).toBe(0)
    })

    test("the first reference range's bounds ride along on the point", () => {
      const { series } = observationsToSeries([
        {
          ...shell,
          effectiveDateTime: at('2024-01-01T00:00:00Z'),
          valueQuantity: quantity(5.4, 'mmol/L', null),
          referenceRange: [
            {
              id: null,
              extension: [],
              modifierExtension: [],
              age: null,
              appliesTo: [],
              low: quantity(4, 'mmol/L', null),
              high: quantity(6, 'mmol/L', null),
              text: null,
              type: null,
            },
          ],
        },
      ])
      expect(series[0].points).toEqual([
        { time: at('2024-01-01T00:00:00Z'), value: 5.4, low: 4, high: 6 },
      ])
    })

    test('a point without a reference range carries no low/high keys at all', () => {
      const { series } = observationsToSeries([
        {
          ...shell,
          effectiveDateTime: at('2024-01-01T00:00:00Z'),
          valueQuantity: quantity(5.4, 'mmol/L', null),
        },
      ])
      expect(Object.keys(series[0].points[0]).toSorted()).toEqual(['time', 'value'])
    })
  })

  describe('accounting', () => {
    test('points are sorted by time whatever order the input arrived in', () => {
      fc.assert(
        fc.property(fc.array(instantArb, { minLength: 1, maxLength: 8 }), (times) => {
          const { series } = observationsToSeries(
            times.map((time) => ({
              ...shell,
              effectiveDateTime: time,
              valueQuantity: quantity(1, 'mmol/L', null),
            }))
          )
          const millis = series[0].points.map((point) => point.time.epochMillis)
          expect(millis).toEqual(millis.toSorted((left, right) => left - right))
        }),
        { numRuns: RUNS }
      )
    })

    test('every observation moves at most one counter', () => {
      const variant = fc.oneof(
        fc.constant({ ...shell, status: 'cancelled' as const }),
        fc.constant({ ...shell, valueString: 'text' }),
        fc.constant({ ...shell, valueQuantity: quantity(1, 'mmol/L', null) }),
        instantArb.map((time) => ({
          ...shell,
          effectiveDateTime: time,
          valueQuantity: quantity(1, 'mmol/L', null),
        }))
      )
      fc.assert(
        fc.property(fc.array(variant, { maxLength: 8 }), (observations) => {
          const { series, undated, dropped } = observationsToSeries(observations)
          const plotted = series.reduce((total, entry) => total + entry.points.length, 0)
          expect(plotted + undated + dropped).toBe(observations.length)
        }),
        { numRuns: RUNS }
      )
    })

    test('a category is read off the first category coding', () => {
      const { series } = observationsToSeries([
        {
          ...shell,
          category: [
            concept(
              'http://terminology.hl7.org/CodeSystem/observation-category',
              'vital-signs',
              null
            ),
          ],
          effectiveDateTime: at('2024-01-01T00:00:00Z'),
          valueQuantity: quantity(72, '/min', null),
        },
      ])
      expect(series[0].category).toBe('vital-signs')
    })
  })
})
