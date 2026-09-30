import { Schema } from 'effect'
import * as fc from 'fast-check'
import { Observation } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as HealthActivity from './health-activity.ts'
import * as WatchDevice from './watch-device.ts'

const { HEALTH_SERVICE_SYSTEM } = HealthActivity

describe('decodeMessage', () => {
  it('should decode a night of sleep into its coding and span', () => {
    // Arrange
    const payload = { ActivityType: 1, ActivityStart: 1_790_000_000, ActivityEnd: 1_790_028_800 }

    // Act
    const activity = HealthActivity.decodeMessage(payload)

    // Assert
    expect(activity).toEqual({
      coding: { system: HEALTH_SERVICE_SYSTEM, code: 'HealthActivitySleep', display: 'Sleeping' },
      startSeconds: 1_790_000_000,
      endSeconds: 1_790_028_800,
    })
  })

  // The keys are pebble.h's HealthActivity values, one bit each.
  it.each([
    [1, 'HealthActivitySleep', 'Sleeping'],
    [2, 'HealthActivityRestfulSleep', 'Restful Sleeping'],
    [4, 'HealthActivityWalk', 'Walking'],
    [8, 'HealthActivityRun', 'Running'],
    [16, 'HealthActivityOpenWorkout', 'Open Workout'],
  ])('should code HealthActivity %i as %s, "%s"', (activityType, code, display) => {
    const activity = HealthActivity.decodeMessage({
      ActivityType: activityType,
      ActivityStart: 0,
      ActivityEnd: 0,
    })
    expect(activity.coding).toEqual({ system: HEALTH_SERVICE_SYSTEM, code, display })
  })

  it('should name each HealthActivityType by the code its activity is coded with', () => {
    for (const [name, activityType] of Object.entries(HealthActivity.HealthActivityType)) {
      const activity = HealthActivity.decodeMessage({
        ActivityType: activityType,
        ActivityStart: 0,
        ActivityEnd: 0,
      })
      expect(activity.coding.code).toBe(`HealthActivity${name}`)
    }
  })

  it('should keep any span that does not end before it starts', () => {
    fc.assert(
      fc.property(activityTypeArbitrary, spanArbitrary, (activityType, [start, end]) => {
        const activity = HealthActivity.decodeMessage({
          ActivityType: activityType,
          ActivityStart: start,
          ActivityEnd: end,
        })
        expect([activity.startSeconds, activity.endSeconds]).toEqual([start, end])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should reject HealthActivityNone and any value that is not a HealthActivity', () => {
    fc.assert(
      fc.property(
        fc.integer().filter((value) => !ACTIVITY_TYPES.includes(value)),
        spanArbitrary,
        (activityType, [start, end]) => {
          expect(() =>
            HealthActivity.decodeMessage({
              ActivityType: activityType,
              ActivityStart: start,
              ActivityEnd: end,
            })
          ).toThrow('HealthActivity')
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should reject an activity that ends before it starts', () => {
    fc.assert(
      fc.property(
        activityTypeArbitrary,
        spanArbitrary,
        fc.integer({ min: 1 }),
        (activityType, [start], shortfall) => {
          expect(() =>
            HealthActivity.decodeMessage({
              ActivityType: activityType,
              ActivityStart: start,
              ActivityEnd: start - shortfall,
            })
          ).toThrow('ends before it starts')
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it.each(['ActivityType', 'ActivityStart', 'ActivityEnd'])(
    'should reject a message whose %s is missing or not an integer',
    (key) => {
      fc.assert(
        fc.property(
          activityTypeArbitrary,
          spanArbitrary,
          fc.constantFrom<unknown>(undefined, 1.5, '1', null),
          (activityType, [start, end], value) => {
            const payload = {
              ActivityType: activityType,
              ActivityStart: start,
              ActivityEnd: end,
              [key]: value,
            }
            expect(() => HealthActivity.decodeMessage(payload)).toThrow(key)
          }
        ),
        { numRuns: numRunsFor({ base: 30 }) }
      )
    }
  )
})

describe('decodeMessage and decodeCount', () => {
  it.each([null, undefined, 'ActivityType', 4])(
    'should reject a payload that is not an object, like %s',
    (payload) => {
      expect(() => HealthActivity.decodeMessage(payload)).toThrow('object')
      expect(() => HealthActivity.decodeCount(payload)).toThrow('object')
    }
  )
})

describe('decodeCount', () => {
  it('should decode any count of activities', () => {
    fc.assert(
      fc.property(fc.nat(), (count) => {
        expect(HealthActivity.decodeCount({ ActivityCount: count })).toBe(count)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should reject a negative, fractional or missing count', () => {
    for (const count of [-1, 0.5, undefined]) {
      expect(() => HealthActivity.decodeCount({ ActivityCount: count })).toThrow('ActivityCount')
    }
  })
})

describe('toObservation', () => {
  it('should record a walk as a final activity Observation for the patient', () => {
    // Arrange
    const activity = HealthActivity.decodeMessage({
      ActivityType: 4,
      ActivityStart: 1_790_000_000,
      ActivityEnd: 1_790_001_800,
    })

    // Act
    const observation = HealthActivity.toObservation(activity, 'ada-lovelace', WATCH)

    // Assert
    expect(observation).toEqual({
      resourceType: 'Observation',
      id: 'wf-8eb6a4ae5c44c216fb2a5acb8d70c5f7',
      status: 'final',
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
            code: 'HealthActivity',
            display: 'Pebble Health Activity',
          },
        ],
      },
      subject: { reference: 'Patient/ada-lovelace' },
      effectivePeriod: { start: '2026-09-21T14:13:20.000Z', end: '2026-09-21T14:43:20.000Z' },
      valueCodeableConcept: {
        coding: [{ system: HEALTH_SERVICE_SYSTEM, code: 'HealthActivityWalk', display: 'Walking' }],
      },
      device: {
        display: 'pebble_time_2_black (emery, firmware 4.9.1)',
        identifier: { system: WatchDevice.WATCH_TOKEN_SYSTEM, value: WATCH_TOKEN },
      },
    })
  })

  it('should always write an Observation the FHIR R4 schema accepts', () => {
    fc.assert(
      fc.property(
        activityArbitrary,
        fc.string({ minLength: 1 }),
        fc.string(),
        fc.string({ minLength: 1 }),
        (activity, patientId, watchDisplay, watchToken) => {
          const device = {
            ...WATCH,
            display: watchDisplay,
            identifier: { ...WATCH.identifier, value: watchToken },
          }
          const observation = HealthActivity.toObservation(activity, patientId, device)
          expect(() => Schema.decodeUnknownSync(Observation.Schema)(observation)).not.toThrow()
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  // The id is what makes sending an activity again harmless: HealthService
  // reports one under way, or one it later refines, again with a later end.
  it('should keep the id when only the end changes', () => {
    fc.assert(
      fc.property(activityArbitrary, fc.nat({ max: 86_400 }), (activity, extraSeconds) => {
        const longer = { ...activity, endSeconds: activity.endSeconds + extraSeconds }
        expect(HealthActivity.toObservation(longer, 'ada-lovelace', WATCH).id).toBe(
          HealthActivity.toObservation(activity, 'ada-lovelace', WATCH).id
        )
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should give activities differing in type, start, patient or watch different ids', () => {
    fc.assert(
      fc.property(
        activityArbitrary,
        activityArbitrary,
        fc.constantFrom('ada-lovelace', 'grace-hopper'),
        fc.constantFrom(WATCH_TOKEN, 'another-watch-token'),
        (first, second, secondPatientId, secondWatchToken) => {
          const secondWatch = {
            ...WATCH,
            identifier: { ...WATCH.identifier, value: secondWatchToken },
          }
          fc.pre(
            first.coding.code !== second.coding.code ||
              first.startSeconds !== second.startSeconds ||
              secondPatientId !== 'ada-lovelace' ||
              secondWatchToken !== WATCH_TOKEN
          )
          expect(HealthActivity.toObservation(first, 'ada-lovelace', WATCH).id).not.toBe(
            HealthActivity.toObservation(second, secondPatientId, secondWatch).id
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always span exactly the activity, to the second', () => {
    fc.assert(
      fc.property(activityArbitrary, (activity) => {
        const { effectivePeriod } = HealthActivity.toObservation(activity, 'ada-lovelace', WATCH)
        expect([
          Date.parse(effectivePeriod.start) / 1000,
          Date.parse(effectivePeriod.end) / 1000,
        ]).toEqual([activity.startSeconds, activity.endSeconds])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const WATCH_TOKEN = '0123456789abcdef0123456789abcdef'

const WATCH: WatchDevice.Reference = WatchDevice.toReference(
  {
    platform: 'emery',
    model: 'pebble_time_2_black',
    firmware: { major: 4, minor: 9, patch: 1, suffix: '' },
  },
  WATCH_TOKEN
)

/** pebble.h's HealthActivity values, less HealthActivityNone. */
const ACTIVITY_TYPES: ReadonlyArray<number> = [1, 2, 4, 8, 16]

const activityTypeArbitrary = fc.constantFrom(...ACTIVITY_TYPES)

/**
 * A `[start, end]` pair of Unix seconds with the end not before the start, both
 * within the int32 range the watch's time_t crosses AppMessage in.
 */
const spanArbitrary: fc.Arbitrary<readonly [number, number]> = fc
  .tuple(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.integer({ min: 0, max: 2 ** 31 - 1 }))
  .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const)

const activityArbitrary: fc.Arbitrary<HealthActivity.Activity> = fc
  .tuple(activityTypeArbitrary, spanArbitrary)
  .map(([activityType, [start, end]]) =>
    HealthActivity.decodeMessage({
      ActivityType: activityType,
      ActivityStart: start,
      ActivityEnd: end,
    })
  )
