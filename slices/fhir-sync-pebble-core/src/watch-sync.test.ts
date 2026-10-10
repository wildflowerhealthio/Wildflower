import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as HealthActivity from './health-activity.ts'
import * as MinuteHistory from './minute-history.ts'
import * as PhoneSettings from './phone-settings.ts'
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
        expect(WatchSync.start({ SyncStart: syncId, ConnectionId: CONNECTION_ID })).toEqual({
          syncId,
          connectionId: CONNECTION_ID,
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
        pending = WatchSync.start({ SyncStart: next.syncId, ConnectionId: next.connectionId })
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
    ['no SyncStart', { ConnectionId: 'wf-0' }],
    ['a fractional SyncStart', { SyncStart: 1.5, ConnectionId: 'wf-0' }],
    ['a string SyncStart', { SyncStart: '1', ConnectionId: 'wf-0' }],
    ['no ConnectionId', { SyncStart: 1 }],
    ['a numeric ConnectionId', { SyncStart: 1, ConnectionId: 0 }],
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
            WatchSync.start({ SyncStart: 7, ConnectionId: CONNECTION_ID })
          )

          // Assert
          expect(sync).toEqual({
            syncId: 7,
            connectionId: CONNECTION_ID,
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

    const started = WatchSync.start({ SyncStart: 7, ConnectionId: CONNECTION_ID })

    // Act
    WatchSync.withActivity(started, activity)

    // Assert
    expect(started).toEqual({
      syncId: 7,
      connectionId: CONNECTION_ID,
      activities: [],
      hours: [],
      undecodable: false,
    })
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
    expect(() =>
      WatchSync.requireComplete(
        WatchSync.start({ SyncStart: 7, ConnectionId: CONNECTION_ID }),
        endPayload
      )
    ).toThrow(key)
  })

  it('should reject an end message that is not an object', () => {
    expect(() =>
      WatchSync.requireComplete(
        WatchSync.start({ SyncStart: 7, ConnectionId: CONNECTION_ID }),
        null
      )
    ).toThrow('object')
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

describe('receive', () => {
  /** The watch's messages for `sync`, from its start to its end. */
  const messagesOf = (sync: WatchSync.Type): Array<unknown> => [
    { SyncStart: sync.syncId, ConnectionId: sync.connectionId },
    ...sync.activities.map((activity) => ({
      ActivityType: activityTypeOf(activity),
      ActivityStart: activity.startSeconds,
      ActivityEnd: activity.endSeconds,
    })),
    ...sync.hours.map((hour) => hourPayloadOf(hour)),
    { ActivityCount: sync.activities.length, MinuteHourCount: sync.hours.length },
  ]

  /** Folds `payloads` into `pending`, keeping every action. */
  const receiveAll = (
    pending: WatchSync.Type | null,
    payloads: ReadonlyArray<unknown>
  ): { readonly pending: WatchSync.Type | null; readonly actions: Array<WatchSync.Action> } =>
    payloads.reduce<{ pending: WatchSync.Type | null; actions: Array<WatchSync.Action> }>(
      (folded, payload) => {
        const step = WatchSync.receive(folded.pending, payload)
        return { pending: step.pending, actions: [...folded.actions, step.action] }
      },
      { pending, actions: [] }
    )

  it('should write a whole sync once it ends, and hold nothing after', () => {
    fc.assert(
      fc.property(syncArbitrary, (sync) => {
        // Act
        const { pending, actions } = receiveAll(null, messagesOf(sync))

        // Assert
        expect(pending).toBeNull()
        expect(actions.slice(0, -1).every(({ _tag }) => _tag === 'Continue')).toBe(true)
        expect(actions.at(-1)).toEqual({ _tag: 'Write', sync })
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should write a sync whole after one the watch abandoned part-way', () => {
    fc.assert(
      fc.property(syncArbitrary, syncArbitrary, fc.nat(), (abandoned, next, cut) => {
        const abandonedMessages = messagesOf(abandoned).slice(0, -1)
        const partial = abandonedMessages.slice(0, 1 + (cut % abandonedMessages.length))
        const { actions } = receiveAll(null, [...partial, ...messagesOf(next)])
        expect(actions.at(-1)).toEqual({ _tag: 'Write', sync: next })
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should fail a sync one of whose messages did not decode, answering its id', () => {
    fc.assert(
      fc.property(syncArbitrary, (sync) => {
        // Arrange: an unknown activity type, counted as an activity.
        const [startMessage, ...rest] = messagesOf(sync)
        const broken = { ActivityType: 3, ActivityStart: 0, ActivityEnd: 0 }
        const endMessage = {
          ActivityCount: sync.activities.length + 1,
          MinuteHourCount: sync.hours.length,
        }

        // Act
        const { pending, actions } = receiveAll(null, [
          startMessage,
          broken,
          ...rest.slice(0, -1),
          endMessage,
        ])

        // Assert
        expect(pending).toBeNull()
        expect(actions[1]?._tag).toBe('Drop')
        expect(actions.at(-1)).toMatchObject({ _tag: 'Fail', syncId: sync.syncId })
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should fail a sync whose counts differ from what arrived', () => {
    fc.assert(
      fc.property(syncArbitrary, (sync) => {
        const messages = messagesOf(sync)
        const { actions } = receiveAll(null, [
          ...messages.slice(0, -1),
          { ActivityCount: sync.activities.length, MinuteHourCount: sync.hours.length + 1 },
        ])
        expect(actions.at(-1)).toMatchObject({ _tag: 'Fail', syncId: sync.syncId })
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it.each([
    ['an activity', { ActivityType: 4, ActivityStart: 0, ActivityEnd: 0 }],
    ['an hour', { MinuteHourStart: 0, MinuteTypes: 0b10, MinuteData: [] }],
    // No id to answer with: the watch's own timeout ends its sync.
    ['the end', { ActivityCount: 0, MinuteHourCount: 0 }],
  ])('should drop %s outside a sync, answering nothing', (_, payload) => {
    expect(WatchSync.receive(null, payload)).toMatchObject({
      pending: null,
      action: { _tag: 'Drop' },
    })
  })

  it('should drop a start that does not decode, leaving no sync under way', () => {
    fc.assert(
      fc.property(syncArbitrary, (sync) => {
        expect(WatchSync.receive(sync, { SyncStart: 'one' })).toMatchObject({
          pending: null,
          action: { _tag: 'Drop' },
        })
      }),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it('should leave the sync alone for a message that is none of its', () => {
    fc.assert(
      fc.property(fc.option(syncArbitrary, { nil: null }), (pending) => {
        expect(WatchSync.receive(pending, { SyncSucceeded: 1, SyncId: 7 })).toEqual({
          pending,
          action: { _tag: 'Continue' },
        })
      }),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })
})

describe('planWrite', () => {
  const readDevice = (): WatchDevice.Reference => WATCH

  it("should PUT the sync's Observations when the watch holds the phone's connection", () => {
    fc.assert(
      fc.property(syncArbitrary, (sync) => {
        const observations = WatchSync.toObservations(sync, SETTINGS.patientId, WATCH)
        expect(WatchSync.planWrite(sync, SETTINGS, readDevice)).toEqual(
          observations.length === 0
            ? { _tag: 'Nothing' }
            : { _tag: 'Transaction', bundle: WatchSync.toTransactionBundle(observations) }
        )
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  // The watch's last-sync times belong to its connection: written to another
  // patient, they would mark that patient's record synced without its history.
  it('should refuse a sync from a watch holding another connection, empty or not', () => {
    fc.assert(
      fc.property(syncArbitrary, fc.string(), (sync, otherConnectionId) => {
        fc.pre(otherConnectionId !== CONNECTION_ID)
        const readDeviceNever = (): WatchDevice.Reference => {
          throw new Error('read the device for a sync it refuses')
        }
        expect(
          WatchSync.planWrite(
            { ...sync, connectionId: otherConnectionId },
            SETTINGS,
            readDeviceNever
          )
        ).toEqual({ _tag: 'WrongConnection' })
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should not read the device when there is nothing to write', () => {
    const empty = WatchSync.start({ SyncStart: 7, ConnectionId: CONNECTION_ID })
    expect(
      WatchSync.planWrite(empty, SETTINGS, () => {
        throw new Error('no watch token')
      })
    ).toEqual({ _tag: 'Nothing' })
  })

  it('should let a failure to read the device fail the write', () => {
    const sync = WatchSync.withActivity(
      WatchSync.start({ SyncStart: 7, ConnectionId: CONNECTION_ID }),
      HealthActivity.decodeMessage({ ActivityType: 4, ActivityStart: 0, ActivityEnd: 60 })
    )
    expect(() =>
      WatchSync.planWrite(sync, SETTINGS, () => {
        throw new Error('no watch token')
      })
    ).toThrow('no watch token')
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

const SETTINGS: PhoneSettings.Settings = {
  patientId: 'ada-lovelace',
  patientName: 'Ada Lovelace',
  patientBirthDate: '1815-12-10',
  accessToken: 'token',
  fhirBaseUrl: 'https://fhir.example/r4',
}

/** The connection `SETTINGS` names, which the watch's syncs carry. */
const CONNECTION_ID = PhoneSettings.connectionId(SETTINGS)

const WATCH: WatchDevice.Reference = WatchDevice.toReference(
  {
    platform: 'emery',
    model: 'pebble_time_2_black',
    firmware: { major: 4, minor: 9, patch: 1, suffix: '' },
  },
  '0123456789abcdef0123456789abcdef'
)

/** The `ActivityType` the watch sent for `activity`. */
const activityTypeOf = (activity: HealthActivity.Activity): number =>
  ACTIVITY_TYPES.find(
    (activityType) =>
      HealthActivity.decodeMessage({ ActivityType: activityType, ActivityStart: 0, ActivityEnd: 0 })
        .coding.code === activity.coding.code
  ) ?? 0

/** The hour message the watch sent for `hour`, laid out as minute-wire.h packs it. */
const hourPayloadOf = (hour: MinuteHistory.Hour): Record<string, unknown> => ({
  MinuteHourStart: hour.hourStartSeconds,
  MinuteTypes: hour.dataTypes.reduce(
    (bits, dataType) => bits | (1 << (DATA_TYPES.indexOf(dataType) + 1)),
    0
  ),
  MinuteData: hour.minutes.flatMap((minute) =>
    minute === null
      ? [0, 0, 0, 0, 1, 0]
      : [
          minute.steps,
          minute.yawBin | (minute.pitchBin << 4),
          minute.vmc & 0xff,
          minute.vmc >> 8,
          minute.light << 1,
          minute.heartRateBpm,
        ]
  ),
})

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
  connectionId: fc.constant(CONNECTION_ID),
  activities: fc.array(activityArbitrary, { maxLength: 5 }),
  hours: fc.array(hourArbitrary, { maxLength: 3 }),
  undecodable: fc.constant(false),
})
