import { Observation } from '@wildflowerhealthio/fhir-r4/resources'
import type { WatchSync } from '@wildflowerhealthio/fhir-sync-pebble-core'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { asOfArbitrary } from '@wildflowerhealthio/synthetic-data-fundamentals/test-helpers'
import { DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as PebbleObservations from './pebble-observations.ts'
import type { Physiology } from './physiology.ts'
import { type DaySpan, type PhysiologyCase, physiologyCaseArbitrary } from './test-helpers.ts'

/**
 * Covers the Pebble generator over generated physiologies: FHIR-valid
 * Observations for the given patient from the given watch, one per minute
 * type for every hour the watch was worn, the recorded activities' periods,
 * the resting heart rate carried into the samples, and determinism and dating
 * over the as-of date. Minute data is large, so most properties run over a
 * few days and few cases; one runs the full 28 days.
 */

const RUNS = numRunsFor({ base: 15 })

const MILLIS_PER_MINUTE = 60_000
const MINUTES_PER_DAY = 1440

const fewDaysArbitrary = physiologyCaseArbitrary({ minDays: 1, maxDays: 3 })

const renderCase = (
  asOf: DateTime.Utc,
  { watch, patientId, physiology }: PhysiologyCase
): ReadonlyArray<WatchSync.Observation> =>
  PebbleObservations.render(asOf, watch, patientId, physiology)

/** The instant a story minute on the physiology's local clock is, as epoch millis. */
const epochMillisOf = (asOf: DateTime.Utc, physiology: Physiology, storyMinute: number): number =>
  DateTime.toEpochMillis(DateTime.startOf(asOf, 'day')) +
  (storyMinute - physiology.utcOffsetHours * 60) * MILLIS_PER_MINUTE

/** The code naming what an Observation holds: its activity's, or its minute type's. */
const kindOf = (observation: WatchSync.Observation): string =>
  'valueCodeableConcept' in observation
    ? (observation.valueCodeableConcept.coding[0]?.code ?? '')
    : (observation.code.coding[0]?.code ?? '')

const HEART_RATE = '8867-4'
const STEPS = '55423-8'
const MOVEMENT = 'HealthMinuteData.vmc'
const MINUTE_KINDS = [HEART_RATE, STEPS, MOVEMENT]

const periodOf = (observation: WatchSync.Observation): readonly [number, number] => [
  Date.parse(observation.effectivePeriod.start),
  Date.parse(observation.effectivePeriod.end),
]

/** An Observation's samples, `null` for `E`. */
const samplesOf = (observation: WatchSync.Observation): ReadonlyArray<number | null> =>
  'valueSampledData' in observation && observation.valueSampledData !== undefined
    ? observation.valueSampledData.data
        .split(' ')
        .map((sample) => (sample === 'E' ? null : Number(sample)))
    : []

const lowerMedianOf = (values: readonly number[]): number =>
  values.toSorted((left, right) => left - right)[Math.floor((values.length - 1) / 2)] ?? Number.NaN

const heartRatesOf = (observations: ReadonlyArray<WatchSync.Observation>): readonly number[] =>
  observations
    .filter((observation) => kindOf(observation) === HEART_RATE)
    .flatMap(samplesOf)
    .filter((sample) => sample !== null)

/**
 * Every UTC hour of the listed days the watch was worn for a minute of: its
 * start, and how many of its minutes the watch spent charging.
 */
const expectedHoursOf = (
  asOf: DateTime.Utc,
  physiology: Physiology
): ReadonlyArray<{ readonly startMillis: number; readonly chargingMinutes: number }> =>
  physiology.days.flatMap(({ day, charging }) =>
    Array.from({ length: 24 }, (_, hour) => {
      const hourStart = hour * 60
      const chargingMinutes = charging.reduce(
        (total, { startMinute, durationMinutes }) =>
          total +
          Math.max(
            0,
            Math.min(hourStart + 60, startMinute + durationMinutes) -
              Math.max(hourStart, startMinute)
          ),
        0
      )
      return {
        startMillis: epochMillisOf(asOf, physiology, day * MINUTES_PER_DAY + hourStart),
        chargingMinutes,
      }
    }).filter(({ chargingMinutes }) => chargingMinutes < 60)
  )

const decodeObservation = Schema.decodeUnknownSync(Observation.Schema)

describe('PebbleObservations.render', () => {
  test('property: every Observation is FHIR R4, for the given patient, from the given watch', () => {
    fc.assert(
      fc.property(asOfArbitrary, fewDaysArbitrary, (asOf, physiologyCase) => {
        const observations = renderCase(asOf, physiologyCase)
        expect(observations.length).toBeGreaterThan(0)
        for (const observation of observations) {
          expect(() => decodeObservation(observation)).not.toThrow()
          expect(observation.subject).toEqual({ reference: `Patient/${physiologyCase.patientId}` })
          expect(observation.device.identifier.value).toBe(physiologyCase.watch.token)
        }
        expect(new Set(observations.map(({ id }) => id)).size).toBe(observations.length)
      }),
      { numRuns: RUNS }
    )
  })

  test('property: each minute type has one Observation per hour worn, `E` for each minute charging', () => {
    fc.assert(
      fc.property(asOfArbitrary, fewDaysArbitrary, (asOf, physiologyCase) => {
        const { physiology } = physiologyCase
        const minuteObservations = renderCase(asOf, physiologyCase).filter((observation) =>
          MINUTE_KINDS.includes(kindOf(observation))
        )
        const expectedHours = expectedHoursOf(asOf, physiology)
        expect(minuteObservations).toHaveLength(expectedHours.length * MINUTE_KINDS.length)
        for (const kind of MINUTE_KINDS) {
          const ofKind = minuteObservations.filter((observation) => kindOf(observation) === kind)
          expect(ofKind.map(periodOf)).toEqual(
            expectedHours.map(({ startMillis }) => [startMillis, startMillis + 60 * 60_000])
          )
          expect(
            ofKind.map((observation) => samplesOf(observation).filter((s) => s === null).length)
          ).toEqual(expectedHours.map(({ chargingMinutes }) => chargingMinutes))
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('property: raising every resting heart rate raises the median heart rate sampled by as much', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        fewDaysArbitrary,
        fc.integer({ min: 1, max: 30 }),
        (asOf, physiologyCase, raiseBpm) => {
          const raised: PhysiologyCase = {
            ...physiologyCase,
            physiology: {
              ...physiologyCase.physiology,
              days: physiologyCase.physiology.days.map((physiologyDay) => ({
                ...physiologyDay,
                restingHeartRateBpm: physiologyDay.restingHeartRateBpm + raiseBpm,
              })),
            },
          }
          const baseline = lowerMedianOf(heartRatesOf(renderCase(asOf, physiologyCase)))
          expect(lowerMedianOf(heartRatesOf(renderCase(asOf, raised)))).toBe(baseline + raiseBpm)
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('property: every sleep, restful sleep and walk comes back as its activity over its span', () => {
    fc.assert(
      fc.property(asOfArbitrary, fewDaysArbitrary, (asOf, physiologyCase) => {
        const { physiology } = physiologyCase
        const periodsOver = (spans: readonly DaySpan[]): ReadonlyArray<readonly [number, number]> =>
          spans
            .map(({ day, span }) => {
              const start = day * MINUTES_PER_DAY + span.startMinute
              return [
                epochMillisOf(asOf, physiology, start),
                epochMillisOf(asOf, physiology, start + span.durationMinutes),
              ] as const
            })
            .toSorted(([left], [right]) => left - right)
        const observations = renderCase(asOf, physiologyCase)
        const periodsOf = (code: string): ReadonlyArray<readonly [number, number]> =>
          observations.filter((observation) => kindOf(observation) === code).map(periodOf)
        expect(periodsOf('HealthActivitySleep')).toEqual(periodsOver(physiologyCase.sleeps))
        expect(periodsOf('HealthActivityRestfulSleep')).toEqual(
          periodsOver(physiologyCase.restfulSleeps)
        )
        expect(periodsOf('HealthActivityWalk')).toEqual(
          periodsOver(
            physiology.days.flatMap(({ day, walks }) => walks.map((span) => ({ day, span })))
          )
        )
      }),
      { numRuns: RUNS }
    )
  })

  test("property: every walking minute's steps are within three of the walk's cadence", () => {
    fc.assert(
      fc.property(asOfArbitrary, fewDaysArbitrary, (asOf, physiologyCase) => {
        const { physiology } = physiologyCase
        const stepsByMillis = new Map(
          renderCase(asOf, physiologyCase)
            .filter((observation) => kindOf(observation) === STEPS)
            .flatMap((observation) =>
              samplesOf(observation).map(
                (steps, minute) => [periodOf(observation)[0] + minute * 60_000, steps] as const
              )
            )
        )
        for (const { day, walks } of physiology.days) {
          for (const walk of walks) {
            for (let minute = 0; minute < walk.durationMinutes; minute++) {
              const millis = epochMillisOf(
                asOf,
                physiology,
                day * MINUTES_PER_DAY + walk.startMinute + minute
              )
              const steps = stepsByMillis.get(millis) ?? Number.NaN
              expect(Math.abs(steps - walk.stepsPerMinute)).toBeLessThanOrEqual(3)
            }
          }
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('property: is identical for any two instants on the same as-of day', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        fc.integer({ min: 0, max: 86_399_999 }),
        fewDaysArbitrary,
        (asOf, millisIntoDay, physiologyCase) => {
          const sameDay = DateTime.add(DateTime.startOf(asOf, 'day'), { millis: millisIntoDay })
          expect(JSON.stringify(renderCase(sameDay, physiologyCase))).toBe(
            JSON.stringify(renderCase(asOf, physiologyCase))
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('property: moving the as-of date moves every period by the same days and keeps every value', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        fc.integer({ min: -400, max: 400 }),
        fewDaysArbitrary,
        (asOf, shiftDays, physiologyCase) => {
          const original = renderCase(asOf, physiologyCase)
          const shifted = renderCase(DateTime.add(asOf, { days: shiftDays }), physiologyCase)
          expect(shifted.map(periodOf)).toEqual(
            original
              .map(periodOf)
              .map(([start, end]) => [start + shiftDays * 86_400_000, end + shiftDays * 86_400_000])
          )
          const valuesOf = (observations: ReadonlyArray<WatchSync.Observation>): unknown[] =>
            observations.map((observation) =>
              'valueCodeableConcept' in observation
                ? observation.valueCodeableConcept
                : observation.valueSampledData
            )
          expect(valuesOf(shifted)).toEqual(valuesOf(original))
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('property: 28 days render one Observation per minute type and hour worn, plus each activity', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        physiologyCaseArbitrary({ minDays: 28, maxDays: 28 }),
        (asOf, physiologyCase) => {
          const observations = renderCase(asOf, physiologyCase)
          const activities = observations.filter(
            (observation) => 'valueCodeableConcept' in observation
          )
          const minuteHours = observations.filter((observation) =>
            MINUTE_KINDS.includes(kindOf(observation))
          )
          const { days } = physiologyCase.physiology
          const walks = days.reduce((total, { walks: dayWalks }) => total + dayWalks.length, 0)
          expect(activities).toHaveLength(
            physiologyCase.sleeps.length + physiologyCase.restfulSleeps.length + walks
          )
          expect(activities.length + minuteHours.length).toBe(observations.length)
          expect(minuteHours).toHaveLength(
            expectedHoursOf(asOf, physiologyCase.physiology).length * MINUTE_KINDS.length
          )
        }
      ),
      { numRuns: numRunsFor({ base: 2, minimum: 1 }) }
    )
  })
})
