import { Arbitrary, DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { Code, CodeableConcept, Period, type Quantity, type SampledData } from 'fhir-r4/data-types'
import { Observation } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { observationSeriesIdOf } from './observation-series-key.ts'
import { EXCLUDED_STATUSES, LOINC_SYSTEM, observationsToSeries } from './observation-series.ts'

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
            expect(series.map((entry) => entry.key.code)).toEqual(codeSet)
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
          const ids = series.map((entry) => entry.id)
          expect(new Set(ids).size).toBe(ids.length)
          expect(ids).toEqual(series.map((entry) => observationSeriesIdOf(entry.key)))
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
      expect(series[0].interpolation).toBe('linear')
      expect(series[0].valueScale).toBe('fitted')
    })

    test('an integer plots as a line, a boolean as a 0 / 1 step', () => {
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
      expect(
        series.map((entry) => [
          entry.interpolation,
          entry.valueScale,
          entry.points.map((point) => point.value),
        ])
      ).toEqual([
        ['linear', 'fitted', [4200]],
        ['step', 'zero-to-one', [1, 0]],
      ])
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

  describe('sampled data', () => {
    const decodeObservation = Schema.decodeUnknownSync(Observation.Schema)

    /** The Pebble HealthService docs page, which FHIR Sync for Pebble codes its own types under. */
    const HEALTH_SERVICE_SYSTEM =
      'https://developer.repebble.com/docs/c/Foundation/Event_Service/HealthService/'

    /** A minute-history `valueSampledData`, shaped as FHIR Sync for Pebble writes it. */
    const minuteSamples = (
      samples: readonly (number | null)[],
      unit: { readonly unit: string; readonly code: string },
      factor: number
    ): typeof SampledData.Schema.Encoded => ({
      origin: { value: 0, unit: unit.unit, system: 'http://unitsofmeasure.org', code: unit.code },
      period: 60_000,
      factor,
      dimensions: 1,
      data: samples.map((sample) => (sample === null ? 'E' : String(sample))).join(' '),
    })

    /** One Pebble hour Observation on the wire, decoded as the adapter receives it. */
    const pebbleHour = (
      hourStart: string,
      hourEnd: string,
      fields: Record<string, unknown>
    ): typeof Observation.Schema.Type =>
      decodeObservation({
        resourceType: 'Observation',
        status: 'final',
        subject: { reference: 'Patient/ada-lovelace' },
        effectivePeriod: { start: hourStart, end: hourEnd },
        device: { display: 'Pebble Time 2' },
        ...fields,
      })

    /** A decoded Observation carrying one `valueSampledData` and whatever timing `fields` states. */
    const sampledObservation = (
      sampledData: Record<string, unknown>,
      fields: Record<string, unknown> = {}
    ): typeof Observation.Schema.Type =>
      decodeObservation({
        resourceType: 'Observation',
        status: 'final',
        code: { coding: [{ system: LOINC_SYSTEM, code: '8867-4' }], text: 'Heart rate' },
        valueSampledData: { origin: { value: 0, unit: '/min' }, period: 60_000, ...sampledData },
        ...fields,
      })

    const numericTokenArb = fc.oneof(
      fc.integer({ min: 0, max: 255 }).map(String),
      fc.double({ min: -1e6, max: 1e6, noNaN: true }).map(String)
    )
    const tokensArb = fc.array(fc.oneof(numericTokenArb, fc.constantFrom('E', 'L', 'U')), {
      maxLength: 60,
    })
    // Kept well inside the representable range so start + index × period always is.
    const startArb = fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) })
    const sampledArb = fc.record({
      tokens: tokensArb,
      origin: fc.double({ min: -1e3, max: 1e3, noNaN: true }),
      factor: fc.option(fc.double({ min: -1e3, max: 1e3, noNaN: true }), { nil: null }),
      period: fc.integer({ min: 1, max: 3_600_000 }),
      startMillis: startArb,
    })

    test('one point per numeric sample, at start + index × period, worth origin + factor × sample', () => {
      fc.assert(
        fc.property(sampledArb, ({ tokens, origin, factor, period, startMillis }) => {
          const observation = sampledObservation(
            {
              origin: { value: origin, unit: '/min' },
              period,
              factor,
              dimensions: 1,
              data: tokens.join(' '),
            },
            { effectivePeriod: { start: new Date(startMillis).toISOString() } }
          )
          const expected = tokens.flatMap((token, index) =>
            ['E', 'L', 'U'].includes(token)
              ? []
              : [
                  {
                    time: startMillis + index * period,
                    value: origin + (factor ?? 1) * Number(token),
                  },
                ]
          )
          const { series, dropped, undated } = observationsToSeries([observation])
          expect(undated).toBe(0)
          if (expected.length === 0) {
            expect(series).toEqual([])
            expect(dropped).toBe(1)
            return
          }
          expect(dropped).toBe(0)
          expect(series).toHaveLength(1)
          const points = series[0].points.map((point) => ({
            time: point.time.epochMillis,
            value: point.value,
          }))
          expect(points).toEqual(expected)
          const millis = points.map((point) => point.time)
          expect(millis).toEqual(millis.toSorted((left, right) => left - right))
        }),
        { numRuns: RUNS }
      )
    })

    test('hours arriving out of order still plot as one time-sorted series', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.integer({ min: 0, max: 48 }), { minLength: 1, maxLength: 6 }),
          fc.array(fc.option(fc.integer({ min: 40, max: 200 }), { nil: null }), {
            minLength: 60,
            maxLength: 60,
          }),
          (hourOffsets, samples) => {
            const observations = hourOffsets.map((offset) => {
              const start = Date.UTC(2026, 8, 27) + offset * 3_600_000
              return sampledObservation(
                { ...minuteSamples(samples, { unit: 'beats/minute', code: '/min' }, 1) },
                { effectivePeriod: { start: new Date(start).toISOString() } }
              )
            })
            const { series } = observationsToSeries(observations)
            const plottedPerHour = samples.filter((sample) => sample !== null).length
            if (plottedPerHour === 0) {
              expect(series).toEqual([])
              return
            }
            expect(series).toHaveLength(1)
            const millis = series[0].points.map((point) => point.time.epochMillis)
            expect(millis).toHaveLength(plottedPerHour * hourOffsets.length)
            expect(millis).toEqual(millis.toSorted((left, right) => left - right))
          }
        ),
        { numRuns: RUNS }
      )
    })

    test('a Pebble hour plots heart rate and both orientation angles as their own series', () => {
      const heartRate: (number | null)[] = Array.from({ length: 60 }, (_, minute) =>
        minute % 7 === 0 ? null : 60 + minute
      )
      const yawBins = Array.from({ length: 60 }, (_, minute) => (minute < 30 ? minute % 16 : null))
      const pitchBins = Array.from({ length: 60 }, (_, minute) => (minute < 30 ? minute % 9 : null))
      const degrees = { unit: 'degrees', code: 'deg' }
      const start = '2026-09-27T10:00:00.000Z'
      const end = '2026-09-27T11:00:00.000Z'
      const { series, dropped, undated } = observationsToSeries([
        pebbleHour(start, end, {
          category: [
            {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                  code: 'vital-signs',
                  display: 'Vital Signs',
                },
              ],
            },
          ],
          code: { coding: [{ system: LOINC_SYSTEM, code: '8867-4', display: 'Heart rate' }] },
          valueSampledData: minuteSamples(heartRate, { unit: 'beats/minute', code: '/min' }, 1),
        }),
        pebbleHour(start, end, {
          category: [
            {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                  code: 'activity',
                  display: 'Activity',
                },
              ],
            },
          ],
          code: {
            coding: [
              {
                system: HEALTH_SERVICE_SYSTEM,
                code: 'HealthMinuteData.orientation',
                display: 'Pebble watch orientation',
              },
            ],
          },
          component: [
            {
              code: {
                coding: [
                  {
                    system: HEALTH_SERVICE_SYSTEM,
                    code: 'HealthMinuteData.orientation.yaw',
                    display: 'Yaw',
                  },
                ],
              },
              valueSampledData: minuteSamples(yawBins, degrees, 22.5),
            },
            {
              code: {
                coding: [
                  {
                    system: HEALTH_SERVICE_SYSTEM,
                    code: 'HealthMinuteData.orientation.pitch',
                    display: 'Pitch',
                  },
                ],
              },
              valueSampledData: minuteSamples(pitchBins, degrees, 22.5),
            },
          ],
        }),
      ])

      expect({ dropped, undated }).toEqual({ dropped: 0, undated: 0 })
      expect(series.map((entry) => [entry.id, entry.label, entry.unit])).toEqual([
        ['o:http://loinc.org|8867-4|beats/minute', 'Heart rate', 'beats/minute'],
        [
          `o:${HEALTH_SERVICE_SYSTEM.replace(/\/$/, '')}|HealthMinuteData.orientation.yaw|degrees`,
          'Pebble watch orientation · Yaw',
          'degrees',
        ],
        [
          `o:${HEALTH_SERVICE_SYSTEM.replace(/\/$/, '')}|HealthMinuteData.orientation.pitch|degrees`,
          'Pebble watch orientation · Pitch',
          'degrees',
        ],
      ])
      expect(series.map((entry) => [entry.interpolation, entry.category])).toEqual([
        ['linear', 'vital-signs'],
        ['linear', 'activity'],
        ['linear', 'activity'],
      ])

      const [heart, yaw] = series
      const startMillis = Date.parse(start)
      expect(heart.points).toHaveLength(heartRate.filter((sample) => sample !== null).length)
      // Minute 0 is an `E` gap, so the first point is minute 1, not minute 0.
      expect(heart.points[0]).toEqual({ time: at('2026-09-27T10:01:00Z'), value: 61 })
      expect(heart.points.map((point) => (point.time.epochMillis - startMillis) / 60_000)).toEqual(
        heartRate.flatMap((sample, minute) => (sample === null ? [] : [minute]))
      )
      expect(yaw.points.map((point) => point.value)).toEqual(
        yawBins.flatMap((bin) => (bin === null ? [] : [bin * 22.5]))
      )
    })

    test('a token that is not a FHIR decimal is skipped, and still counts toward later times', () => {
      const { series } = observationsToSeries([
        sampledObservation(
          { data: 'Infinity 0x1F NaN 1,5 +2 7', dimensions: 1 },
          { effectiveDateTime: '2026-09-27T10:00:00Z' }
        ),
      ])
      expect(series[0].points).toEqual([{ time: at('2026-09-27T10:05:00Z'), value: 7 }])
    })

    test("sample 0's time is the period start, else the dateTime, else the instant — never issued", () => {
      // A decoded resource populates at most one `effective[x]` slot, so the
      // slots are spread onto it the way the effective-time property does.
      // Each is absent half the time, so "only `issued`" comes up often.
      const slots = fc.record({
        effectiveDateTime: fc.option(instantArb, { nil: null, freq: 2 }),
        effectivePeriod: fc.option(periodArb, { nil: null, freq: 2 }),
        effectiveInstant: fc.option(instantArb, { nil: null, freq: 2 }),
        issued: fc.option(instantArb, { nil: null, freq: 2 }),
      })
      const observation = sampledObservation({ data: '72', dimensions: 1 })
      fc.assert(
        fc.property(slots, (times) => {
          const expected =
            times.effectivePeriod?.start ??
            times.effectiveDateTime ??
            times.effectiveInstant ??
            null
          const { series, undated } = observationsToSeries([{ ...observation, ...times }])
          if (expected === null) {
            expect(series).toEqual([])
            expect(undated).toBe(1)
          } else {
            expect(series[0].points).toEqual([{ time: expected, value: 72 }])
          }
        }),
        { numRuns: RUNS }
      )
    })

    test('more than one dimension is dropped rather than plotted as one', () => {
      const { series, dropped, undated } = observationsToSeries([
        sampledObservation(
          { data: '1 2 3 4', dimensions: 2 },
          { effectivePeriod: { start: '2026-09-27T10:00:00Z' } }
        ),
      ])
      expect({ series, dropped, undated }).toEqual({ series: [], dropped: 1, undated: 0 })
    })

    test('a zero or negative period is dropped rather than stacked or run backwards', () => {
      fc.assert(
        fc.property(fc.integer({ min: -3_600_000, max: 0 }), (period) => {
          const { series, dropped, undated } = observationsToSeries([
            sampledObservation(
              { data: '72 73 74', dimensions: 1, period },
              { effectivePeriod: { start: '2026-09-27T10:00:00Z' } }
            ),
          ])
          expect({ series, dropped, undated }).toEqual({ series: [], dropped: 1, undated: 0 })
        }),
        { numRuns: RUNS }
      )
    })

    test('samples with no stated start are undated, even when the resource was issued', () => {
      const { series, dropped, undated } = observationsToSeries([
        sampledObservation({ data: '72 73', dimensions: 1 }),
        sampledObservation({ data: '72 73', dimensions: 1 }, { issued: '2026-09-27T12:00:00Z' }),
      ])
      expect({ series, dropped, undated }).toEqual({ series: [], dropped: 0, undated: 2 })
    })

    test('an observation plots whole or not at all when only some of its readings are dated', () => {
      // `issued` dates the scalar but not the samples, so neither plots.
      const panel = decodeObservation({
        resourceType: 'Observation',
        status: 'final',
        code: { text: 'Panel' },
        issued: '2026-09-27T12:00:00Z',
        valueQuantity: { value: 5, unit: 'mmol/L' },
        component: [
          {
            code: { text: 'Trace' },
            valueSampledData: { origin: { value: 0 }, period: 60_000, dimensions: 1, data: '1 2' },
          },
        ],
      })
      expect(observationsToSeries([panel])).toEqual({ series: [], undated: 1, dropped: 0 })
    })

    test('every sample takes the first reference range of its slot', () => {
      const { series } = observationsToSeries([
        sampledObservation(
          { data: '72 E 110', dimensions: 1 },
          {
            effectivePeriod: { start: '2026-09-27T10:00:00Z' },
            referenceRange: [{ low: { value: 60 }, high: { value: 100 } }],
          }
        ),
      ])
      expect(series[0].points).toEqual([
        { time: at('2026-09-27T10:00:00Z'), value: 72, low: 60, high: 100 },
        { time: at('2026-09-27T10:02:00Z'), value: 110, low: 60, high: 100 },
      ])
    })

    test('every observation moves at most one counter, however many samples it carries', () => {
      const anchored = { effectivePeriod: { start: '2026-09-27T10:00:00Z' } }
      const variant = fc.constantFrom(
        sampledObservation({ data: '1 E 3', dimensions: 1 }, anchored),
        sampledObservation({ data: '1 2 3', dimensions: 2 }, anchored),
        sampledObservation({ data: 'E L U', dimensions: 1 }, anchored),
        sampledObservation({ data: '1 2 3', dimensions: 1 }),
        sampledObservation({ data: '1 2 3', dimensions: 1 }, { issued: '2026-09-27T12:00:00Z' }),
        { ...shell, effectiveDateTime: at('2024-01-01T00:00:00Z'), valueString: 'text' }
      )
      fc.assert(
        fc.property(fc.array(variant, { maxLength: 8 }), (variants) => {
          // A distinct code per observation, so each one that plots is its own series.
          const observations = variants.map((observation, index) => ({
            ...observation,
            code: concept(null, `obs-${index}`, null),
          }))
          const { series, undated, dropped } = observationsToSeries(observations)
          expect(series.length + undated + dropped).toBe(observations.length)
        }),
        { numRuns: RUNS }
      )
    })
  })
})
