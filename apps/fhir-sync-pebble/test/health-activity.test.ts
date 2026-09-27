import { Schema } from 'effect'
import * as fc from 'fast-check'
import { Observation } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

// PebbleKit JS is CommonJS, which vite.config.ts hands to Node's own loader;
// health-activity.d.ts types it.
import {
  type Activity,
  decodeActivityCount,
  decodeActivityMessage,
  describeWatch,
  HEALTH_SERVICE_SYSTEM,
  toObservation,
  toTransactionBundle,
} from '../src/pkjs/health-activity.js'
import { toObservations } from '../src/pkjs/minute-history.js'

describe('decodeActivityMessage', () => {
  it('decodes a night of sleep into its coding and span', () => {
    // Arrange
    const payload = { ActivityType: 1, ActivityStart: 1_790_000_000, ActivityEnd: 1_790_028_800 }

    // Act
    const activity = decodeActivityMessage(payload)

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
  ])('codes HealthActivity %i as %s, "%s"', (activityType, code, display) => {
    const activity = decodeActivityMessage({
      ActivityType: activityType,
      ActivityStart: 0,
      ActivityEnd: 0,
    })
    expect(activity.coding).toEqual({ system: HEALTH_SERVICE_SYSTEM, code, display })
  })

  it('keeps any span that does not end before it starts', () => {
    fc.assert(
      fc.property(activityTypeArbitrary, spanArbitrary, (activityType, [start, end]) => {
        const activity = decodeActivityMessage({
          ActivityType: activityType,
          ActivityStart: start,
          ActivityEnd: end,
        })
        expect([activity.startSeconds, activity.endSeconds]).toEqual([start, end])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects HealthActivityNone and any value that is not a HealthActivity', () => {
    fc.assert(
      fc.property(
        fc.integer().filter((value) => !ACTIVITY_TYPES.includes(value)),
        spanArbitrary,
        (activityType, [start, end]) => {
          expect(() =>
            decodeActivityMessage({
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

  it('rejects an activity that ends before it starts', () => {
    fc.assert(
      fc.property(
        activityTypeArbitrary,
        spanArbitrary,
        fc.integer({ min: 1 }),
        (activityType, [start], shortfall) => {
          expect(() =>
            decodeActivityMessage({
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
    'rejects a message whose %s is missing or not an integer',
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
            expect(() => decodeActivityMessage(payload)).toThrow(key)
          }
        ),
        { numRuns: numRunsFor({ base: 30 }) }
      )
    }
  )
})

describe('decodeActivityCount', () => {
  it('decodes any count of activities', () => {
    fc.assert(
      fc.property(fc.nat(), (count) => {
        expect(decodeActivityCount({ ActivityCount: count })).toBe(count)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('rejects a negative, fractional or missing count', () => {
    for (const count of [-1, 0.5, undefined]) {
      expect(() => decodeActivityCount({ ActivityCount: count })).toThrow('ActivityCount')
    }
  })
})

describe('describeWatch', () => {
  it('names the model, platform and firmware', () => {
    // Arrange
    const watchInfo = {
      platform: 'emery',
      model: 'pebble_time_2_black',
      language: 'en_US',
      firmware: { major: 4, minor: 9, patch: 1, suffix: '' },
    }

    // Act
    const display = describeWatch(watchInfo)

    // Assert
    expect(display).toBe('pebble_time_2_black (emery, firmware 4.9.1)')
  })

  it('adds a firmware suffix when there is one', () => {
    const watchInfo = {
      platform: 'emery',
      model: 'pebble_time_2_black',
      firmware: { major: 4, minor: 9, patch: 1, suffix: 'beta2' },
    }
    expect(describeWatch(watchInfo)).toBe('pebble_time_2_black (emery, firmware 4.9.1-beta2)')
  })

  it.each([
    ['undefined', undefined],
    ['no firmware', { platform: 'emery', model: 'pebble_time_2_black' }],
    ['no model', { platform: 'emery', firmware: { major: 4, minor: 9, patch: 1 } }],
    [
      'a fractional firmware version',
      { platform: 'emery', model: 'm', firmware: { major: 4.5, minor: 9, patch: 1 } },
    ],
  ])('rejects watch info with %s', (_, watchInfo) => {
    expect(() => describeWatch(watchInfo)).toThrow()
  })
})

describe('toObservation', () => {
  it('records a walk as a final activity Observation for the patient', () => {
    // Arrange
    const activity = decodeActivityMessage({
      ActivityType: 4,
      ActivityStart: 1_790_000_000,
      ActivityEnd: 1_790_001_800,
    })

    // Act
    const observation = toObservation(
      activity,
      'ada-lovelace',
      'pebble_time_2_black (emery, firmware 4.9.1)'
    )

    // Assert
    expect(observation).toEqual({
      resourceType: 'Observation',
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
      device: { display: 'pebble_time_2_black (emery, firmware 4.9.1)' },
    })
  })

  it('always writes an Observation the FHIR R4 schema accepts', () => {
    fc.assert(
      fc.property(
        activityArbitrary,
        fc.string({ minLength: 1 }),
        fc.string(),
        (activity, patientId, watchDisplay) => {
          const observation = toObservation(activity, patientId, watchDisplay)
          expect(() => Schema.decodeUnknownSync(Observation.Schema)(observation)).not.toThrow()
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('always spans exactly the activity, to the second', () => {
    fc.assert(
      fc.property(activityArbitrary, (activity) => {
        const { effectivePeriod } = toObservation(activity, 'ada-lovelace', 'watch')
        expect([
          Date.parse(effectivePeriod.start) / 1000,
          Date.parse(effectivePeriod.end) / 1000,
        ]).toEqual([activity.startSeconds, activity.endSeconds])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('toTransactionBundle', () => {
  it('creates each Observation, in order, in one transaction', () => {
    fc.assert(
      fc.property(fc.array(activityArbitrary), (activities) => {
        // Arrange
        const observations = activities.map((activity) =>
          toObservation(activity, 'ada-lovelace', 'watch')
        )

        // Act
        const bundle = toTransactionBundle(observations)

        // Assert
        expect(bundle).toEqual({
          resourceType: 'Bundle',
          type: 'transaction',
          entry: observations.map((resource) => ({
            resource,
            request: { method: 'POST', url: 'Observation' },
          })),
        })
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('carries activity and minute-history Observations in one transaction', () => {
    // Arrange
    const walk = toObservation(
      decodeActivityMessage({
        ActivityType: 4,
        ActivityStart: 1_790_000_000,
        ActivityEnd: 1_790_001_800,
      }),
      'ada-lovelace',
      'watch'
    )
    const [steps] = toObservations(
      {
        hourStartSeconds: 1_789_999_200,
        dataTypes: ['steps'],
        minutes: Array.from({ length: 60 }, () => ({
          steps: 90,
          yawBin: 0,
          pitchBin: 4,
          vmc: 800,
          light: 3,
          heartRateBpm: 110,
        })),
      },
      'ada-lovelace',
      'watch'
    )

    // Act
    const bundle = toTransactionBundle([walk, steps])

    // Assert
    expect(bundle.entry.map(({ resource }) => resource)).toEqual([walk, steps])
  })
})

// Helpers

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

const activityArbitrary: fc.Arbitrary<Activity> = fc
  .tuple(activityTypeArbitrary, spanArbitrary)
  .map(([activityType, [start, end]]) =>
    decodeActivityMessage({ ActivityType: activityType, ActivityStart: start, ActivityEnd: end })
  )
