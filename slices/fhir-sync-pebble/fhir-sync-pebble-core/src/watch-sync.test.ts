import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as HealthActivity from './health-activity.ts'
import * as MinuteHistory from './minute-history.ts'
import * as WatchDevice from './watch-device.ts'
import * as WatchSync from './watch-sync.ts'

describe('messageKind', () => {
  it.each([
    ['the start of the sync', { SyncStart: 1_790_000_000 }, 'Start'],
    ['an activity', { ActivityType: 4, ActivityStart: 0, ActivityEnd: 0 }, 'Activity'],
    ['an hour', { MinuteHourStart: 0, MinuteTypes: 0b10, MinuteData: [] }, 'MinuteHour'],
    ['the end of the sync', { ActivityCount: 0, MinuteHourCount: 0 }, 'End'],
    ['a message that does not decode', { ActivityType: 'walk' }, 'Activity'],
    ['a message outside the sync', { SyncSucceeded: 1, SyncId: 7 }, null],
  ] as const)('should tell %s by its key', (_, payload, kind) => {
    expect(WatchSync.messageKind(payload)).toBe(kind)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'ActivityType'],
    ['a number', 4],
  ])('should call a payload that is %s none of them', (_, payload) => {
    expect(WatchSync.messageKind(payload)).toBeNull()
  })

  it.each([
    ['SyncStart over ActivityType', { ActivityType: 4, SyncStart: 1 }, 'Start'],
    ['SyncStart over ActivityCount', { ActivityCount: 0, SyncStart: 1 }, 'Start'],
    ['ActivityType over MinuteHourStart', { ActivityType: 4, MinuteHourStart: 0 }, 'Activity'],
    ['ActivityType over ActivityCount', { ActivityType: 4, ActivityCount: 0 }, 'Activity'],
    ['MinuteHourStart over ActivityCount', { MinuteHourStart: 0, ActivityCount: 0 }, 'MinuteHour'],
    [
      'ActivityType over both',
      { ActivityCount: 0, MinuteHourStart: 0, ActivityType: 4 },
      'Activity',
    ],
  ] as const)('should rank %s when a payload carries several keys', (_, payload, kind) => {
    expect(WatchSync.messageKind(payload)).toBe(kind)
  })
})

describe('start', () => {
  it('should start a sync holding nothing under the id the watch gave it', () => {
    fc.assert(
      fc.property(fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), (syncId) => {
        expect(WatchSync.start({ SyncStart: syncId })).toEqual({
          syncId,
          activities: [],
          hours: [],
          undecodable: false,
        })
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  // What SyncStart exists for: an abandoned sync's leftovers never reach the
  // next one, so its counts still match.
  it('should complete a sync started after an abandoned one', () => {
    fc.assert(
      fc.property(syncArbitrary, syncArbitrary, (abandoned, next) => {
        // Arrange: the phone holds whatever the abandoned sync got through.
        let pending: WatchSync.Type = WatchSync.asUndecodable(abandoned)

        // Act
        pending = WatchSync.start({ SyncStart: next.syncId })
        pending = next.activities.reduce(WatchSync.withActivity, pending)
        pending = next.hours.reduce(WatchSync.withHour, pending)

        // Assert
        expect(
          WatchSync.requireComplete(pending, {
            ActivityCount: next.activities.length,
            MinuteHourCount: next.hours.length,
          })
        ).toEqual(next)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it.each([
    ['no SyncStart', {}],
    ['a fractional SyncStart', { SyncStart: 1.5 }],
    ['a string SyncStart', { SyncStart: '1' }],
    ['a payload that is not an object', null],
  ])('should reject a start message with %s', (_, payload) => {
    expect(() => WatchSync.start(payload)).toThrow()
  })
})

describe('withActivity and withHour', () => {
  it('should keep every message in the order it arrived', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(activityMessageArbitrary, hourMessageArbitrary)),
        (messages) => {
          // Act
          const sync = messages.reduce(
            (collected, message) =>
              message._tag === 'Activity'
                ? WatchSync.withActivity(collected, message.activity)
                : WatchSync.withHour(collected, message.hour),
            WatchSync.start({ SyncStart: 7 })
          )

          // Assert
          expect(sync).toEqual({
            syncId: 7,
            undecodable: false,
            activities: messages.flatMap((message) =>
              message._tag === 'Activity' ? [message.activity] : []
            ),
            hours: messages.flatMap((message) => (message._tag === 'Hour' ? [message.hour] : [])),
          })
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should leave the sync it adds to as it was', () => {
    // Arrange
    const activity = HealthActivity.decodeMessage({
      ActivityType: 4,
      ActivityStart: 1_790_000_000,
      ActivityEnd: 1_790_001_800,
    })

    const started = WatchSync.start({ SyncStart: 7 })

    // Act
    WatchSync.withActivity(started, activity)

    // Assert
    expect(started).toEqual({ syncId: 7, activities: [], hours: [], undecodable: false })
  })
})

describe('requireComplete', () => {
  it('should confirm a sync holding as many activities and hours as the watch counted', () => {
    fc.assert(
      fc.property(syncArbitrary, (sync) => {
        const endPayload = {
          ActivityCount: sync.activities.length,
          MinuteHourCount: sync.hours.length,
        }
        expect(WatchSync.requireComplete(sync, endPayload)).toBe(sync)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should reject a sync missing a message the watch counted', () => {
    fc.assert(
      fc.property(
        syncArbitrary,
        fc.nat({ max: 3 }),
        fc.nat({ max: 3 }),
        (sync, extraActivities, extraHours) => {
          fc.pre(extraActivities + extraHours > 0)
          const endPayload = {
            ActivityCount: sync.activities.length + extraActivities,
            MinuteHourCount: sync.hours.length + extraHours,
          }
          expect(() => WatchSync.requireComplete(sync, endPayload)).toThrow('did not all arrive')
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should reject a sync one of whose messages failed to decode', () => {
    fc.assert(
      fc.property(syncArbitrary, (sync) => {
        const endPayload = {
          ActivityCount: sync.activities.length,
          MinuteHourCount: sync.hours.length,
        }
        expect(() => WatchSync.requireComplete(WatchSync.asUndecodable(sync), endPayload)).toThrow(
          'did not all arrive'
        )
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it.each([
    ['no MinuteHourCount', { ActivityCount: 0 }, 'MinuteHourCount'],
    ['a negative ActivityCount', { ActivityCount: -1, MinuteHourCount: 0 }, 'ActivityCount'],
    ['a fractional MinuteHourCount', { ActivityCount: 0, MinuteHourCount: 0.5 }, 'MinuteHourCount'],
  ])('should reject an end message with %s', (_, endPayload, key) => {
    expect(() => WatchSync.requireComplete(WatchSync.start({ SyncStart: 7 }), endPayload)).toThrow(
      key
    )
  })

  it('should reject an end message that is not an object', () => {
    expect(() => WatchSync.requireComplete(WatchSync.start({ SyncStart: 7 }), null)).toThrow(
      'object'
    )
  })
})

describe('isEmpty', () => {
  it('should hold only for a sync with no activity and no hour', () => {
    fc.assert(
      fc.property(syncArbitrary, (sync) => {
        expect(WatchSync.isEmpty(sync)).toBe(
          sync.activities.length === 0 && sync.hours.length === 0
        )
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('toObservations', () => {
  it("should record the activities, then each hour's minute types, in the order they arrived", () => {
    fc.assert(
      fc.property(syncArbitrary, (sync) => {
        expect(WatchSync.toObservations(sync, 'ada-lovelace', WATCH)).toEqual([
          ...sync.activities.map((activity) =>
            HealthActivity.toObservation(activity, 'ada-lovelace', WATCH)
          ),
          ...sync.hours.flatMap((hour) =>
            MinuteHistory.toObservations(hour, 'ada-lovelace', WATCH)
          ),
        ])
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('toTransactionBundle', () => {
  it('should PUT each Observation to its id, in order, in one transaction', () => {
    fc.assert(
      fc.property(syncArbitrary, (sync) => {
        // Arrange
        const observations = WatchSync.toObservations(sync, 'ada-lovelace', WATCH)

        // Act
        const bundle = WatchSync.toTransactionBundle(observations)

        // Assert
        expect(bundle).toEqual({
          resourceType: 'Bundle',
          type: 'transaction',
          entry: observations.map((resource) => ({
            resource,
            request: { method: 'PUT', url: `Observation/${resource.id}` },
          })),
        })
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should carry activity and minute-history Observations in one transaction', () => {
    // Arrange
    const walk = HealthActivity.toObservation(
      HealthActivity.decodeMessage({
        ActivityType: 4,
        ActivityStart: 1_790_000_000,
        ActivityEnd: 1_790_001_800,
      }),
      'ada-lovelace',
      WATCH
    )
    const steps = MinuteHistory.toObservations(
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
      WATCH
    )

    // Act
    const bundle = WatchSync.toTransactionBundle([walk, ...steps])

    // Assert
    expect(steps).toHaveLength(1)
    expect(bundle.entry.map(({ resource }) => resource)).toEqual([walk, ...steps])
  })

  // Idempotence: a sync sent again, or one that overlaps the last, writes the
  // same entries, so the server ends up holding each Observation once.
  it('should write a sync sent twice to the same ids', () => {
    fc.assert(
      fc.property(syncArbitrary, (sync) => {
        const requestsOf = (): Array<string> =>
          WatchSync.toTransactionBundle(
            WatchSync.toObservations(sync, 'ada-lovelace', WATCH)
          ).entry.map(({ request }) => `${request.method} ${request.url}`)
        expect(requestsOf()).toEqual(requestsOf())
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

describe('toResultMessage', () => {
  it.each([
    [true, 1],
    [false, 0],
  ] as const)('should answer %s as SyncSucceeded %i with the sync id', (succeeded, flag) => {
    expect(WatchSync.toResultMessage(1_790_000_000, succeeded)).toEqual({
      SyncSucceeded: flag,
      SyncId: 1_790_000_000,
    })
  })
})

// Helpers

const WATCH: WatchDevice.Reference = WatchDevice.toReference(
  {
    platform: 'emery',
    model: 'pebble_time_2_black',
    firmware: { major: 4, minor: 9, patch: 1, suffix: '' },
  },
  '0123456789abcdef0123456789abcdef'
)

/** pebble.h's HealthActivity values, less HealthActivityNone. */
const ACTIVITY_TYPES: ReadonlyArray<number> = [1, 2, 4, 8, 16]

/** The minute types, in `DataType` order. */
const DATA_TYPES: ReadonlyArray<MinuteHistory.DataType> = [
  'heartRate',
  'steps',
  'orientation',
  'movement',
  'ambientLight',
]

const activityArbitrary: fc.Arbitrary<HealthActivity.Activity> = fc
  .tuple(
    fc.constantFrom(...ACTIVITY_TYPES),
    fc.integer({ min: 0, max: 2 ** 31 - 1 }),
    fc.integer({ min: 0, max: 2 ** 31 - 1 })
  )
  .map(([activityType, a, b]) =>
    HealthActivity.decodeMessage({
      ActivityType: activityType,
      ActivityStart: Math.min(a, b),
      ActivityEnd: Math.max(a, b),
    })
  )

const minuteArbitrary: fc.Arbitrary<MinuteHistory.Minute> = fc.record({
  steps: fc.integer({ min: 0, max: 255 }),
  yawBin: fc.integer({ min: 0, max: 15 }),
  pitchBin: fc.integer({ min: 0, max: 15 }),
  vmc: fc.integer({ min: 0, max: 65_535 }),
  light: fc.integer({ min: 0, max: 4 }),
  heartRateBpm: fc.integer({ min: 0, max: 255 }),
})

const hourArbitrary: fc.Arbitrary<MinuteHistory.Hour> = fc.record({
  hourStartSeconds: fc
    .integer({ min: 0, max: Math.floor((2 ** 31 - 1) / 3600) })
    .map((hours) => hours * 3600),
  dataTypes: fc.subarray([...DATA_TYPES], { minLength: 1 }),
  minutes: fc.array(fc.option(minuteArbitrary, { nil: null }), { minLength: 60, maxLength: 60 }),
})

/** One decoded message of the sync, as the phone would add it. */
type SyncMessage =
  | { readonly _tag: 'Activity'; readonly activity: HealthActivity.Activity }
  | { readonly _tag: 'Hour'; readonly hour: MinuteHistory.Hour }

const activityMessageArbitrary: fc.Arbitrary<SyncMessage> = activityArbitrary.map((activity) => ({
  _tag: 'Activity',
  activity,
}))

const hourMessageArbitrary: fc.Arbitrary<SyncMessage> = hourArbitrary.map((hour) => ({
  _tag: 'Hour',
  hour,
}))

const syncArbitrary: fc.Arbitrary<WatchSync.Type> = fc.record({
  syncId: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
  activities: fc.array(activityArbitrary, { maxLength: 5 }),
  hours: fc.array(hourArbitrary, { maxLength: 3 }),
  undecodable: fc.constant(false),
})
