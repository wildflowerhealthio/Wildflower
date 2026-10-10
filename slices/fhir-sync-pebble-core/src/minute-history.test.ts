import { Observation } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import type { Fields } from './fields.ts'
import { HEALTH_SERVICE_SYSTEM } from './health-activity.ts'
import * as MinuteHistory from './minute-history.ts'
import * as WatchDevice from './watch-device.ts'

describe('decodeHourMessage', () => {
  it('should decode an hour with one valid minute', () => {
    // Arrange
    const minutes = [
      { steps: 12, yawBin: 4, pitchBin: 2, vmc: 300, light: 3, heartRateBpm: 72 },
      ...Array.from({ length: 59 }, () => null),
    ]
    const payload = hourPayload(SEPTEMBER_27_2026_10AM, 0b1010, minutes)

    // Act
    const hour = MinuteHistory.decodeHourMessage(payload)

    // Assert
    expect(hour).toEqual({
      hourStartSeconds: SEPTEMBER_27_2026_10AM,
      dataTypes: ['heartRate', 'orientation'],
      minutes,
    })
  })

  it('should decode whatever hour, types and minutes the watch packs', () => {
    fc.assert(
      fc.property(hourArbitrary, (hour) => {
        const payload = hourPayload(hour.hourStartSeconds, typeBitsOf(hour.dataTypes), hour.minutes)
        expect(MinuteHistory.decodeHourMessage(payload)).toEqual(hour)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should reject an hour start that is not on the hour', () => {
    fc.assert(
      fc.property(hourArbitrary, fc.integer({ min: 1, max: 3599 }), (hour, offset) => {
        const payload = hourPayload(
          hour.hourStartSeconds + offset,
          typeBitsOf(hour.dataTypes),
          hour.minutes
        )
        expect(() => MinuteHistory.decodeHourMessage(payload)).toThrow('MinuteHourStart')
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it.each([
    ['no type', 0],
    ['Health Activity, which is not a minute type', 0b1],
    ['a bit past the last data type', 0b1000000],
    ['a negative mask', -2],
  ])('should reject MinuteTypes with %s', (_, typeBits) => {
    const payload = hourPayload(SEPTEMBER_27_2026_10AM, typeBits, allInvalid())
    expect(() => MinuteHistory.decodeHourMessage(payload)).toThrow('MinuteTypes')
  })

  it('should reject MinuteData that is not 360 bytes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 })).filter((bytes) => bytes.length !== 360),
        (bytes) => {
          const payload = {
            MinuteHourStart: SEPTEMBER_27_2026_10AM,
            MinuteTypes: 0b10,
            MinuteData: bytes,
          }
          expect(() => MinuteHistory.decodeHourMessage(payload)).toThrow('MinuteData')
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it.each([
    ['above 255', 256],
    ['negative', -1],
    ['fractional', 0.5],
  ])('should reject MinuteData holding a value %s', (_, value) => {
    const bytes: Array<number> = packMinutes(allInvalid())
    bytes[7] = value
    const payload = {
      MinuteHourStart: SEPTEMBER_27_2026_10AM,
      MinuteTypes: 0b10,
      MinuteData: bytes,
    }
    expect(() => MinuteHistory.decodeHourMessage(payload)).toThrow('MinuteData')
  })
})

describe('decodeHourMessage and decodeHourCount', () => {
  it.each([null, undefined, 'MinuteHourStart', 4])(
    'should reject a payload that is not an object, like %s',
    (payload) => {
      expect(() => MinuteHistory.decodeHourMessage(payload)).toThrow('object')
      expect(() => MinuteHistory.decodeHourCount(payload)).toThrow('object')
    }
  )
})

describe('decodeHourCount', () => {
  it('should decode any count of hours', () => {
    fc.assert(
      fc.property(fc.nat(), (count) => {
        expect(MinuteHistory.decodeHourCount({ MinuteHourCount: count })).toBe(count)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should reject a negative, fractional or missing count', () => {
    for (const count of [-1, 0.5, undefined]) {
      expect(() => MinuteHistory.decodeHourCount({ MinuteHourCount: count })).toThrow(
        'MinuteHourCount'
      )
    }
  })
})

describe('toObservations', () => {
  it('should record an hour of heart rate as per-minute samples, E where there was no reading', () => {
    // Arrange
    const hour: MinuteHistory.Hour = {
      hourStartSeconds: SEPTEMBER_27_2026_10AM,
      dataTypes: ['heartRate'],
      minutes: [
        minuteWith({ heartRateBpm: 72 }),
        minuteWith({ heartRateBpm: 0 }),
        ...allInvalid().slice(2),
      ],
    }

    // Act
    const observations = MinuteHistory.toObservations(hour, 'ada-lovelace', WATCH)

    // Assert
    expect(observations).toEqual([
      {
        resourceType: 'Observation',
        id: 'wf-f1d98d8af56586e91b7bbec9c5445ff4',
        status: 'final',
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
        code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] },
        subject: { reference: 'Patient/ada-lovelace' },
        effectivePeriod: { start: '2026-09-27T10:00:00.000Z', end: '2026-09-27T11:00:00.000Z' },
        valueSampledData: {
          origin: {
            value: 0,
            unit: 'beats/minute',
            system: 'http://unitsofmeasure.org',
            code: '/min',
          },
          period: 60_000,
          factor: 1,
          dimensions: 1,
          data: ['72', 'E', ...Array.from({ length: 58 }, () => 'E')].join(' '),
        },
        device: WATCH,
      },
    ])
  })

  // The id is what makes sending an hour again harmless.
  it("should keep each type's id for the hour whatever its minutes", () => {
    fc.assert(
      fc.property(
        hourArbitrary,
        fc.array(fullMinuteArbitrary, { minLength: 60, maxLength: 60 }),
        fc.array(fullMinuteArbitrary, { minLength: 60, maxLength: 60 }),
        (hour, firstMinutes, secondMinutes) => {
          const idsOf = (minutes: ReadonlyArray<MinuteHistory.Minute>): Array<string> =>
            MinuteHistory.toObservations({ ...hour, minutes }, 'ada-lovelace', WATCH).map(
              ({ id }) => id
            )
          expect(idsOf(secondMinutes)).toEqual(idsOf(firstMinutes))
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should give every type, hour and patient its own id', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 500_000 }), { minLength: 1, maxLength: 4 }),
        fc.array(fullMinuteArbitrary, { minLength: 60, maxLength: 60 }),
        (hourNumbers, minutes) => {
          const ids = ['ada-lovelace', 'grace-hopper'].flatMap((patientId) =>
            [...new Set(hourNumbers)].flatMap((hourNumber) =>
              MinuteHistory.toObservations(
                {
                  hourStartSeconds: hourNumber * 3600,
                  dataTypes: MINUTE_TYPE_BITS.map(([dataType]) => dataType),
                  minutes,
                },
                patientId,
                WATCH
              ).map(({ id }) => id)
            )
          )
          expect(new Set(ids).size).toBe(ids.length)
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should record orientation as yaw and pitch components in degrees, 22.5 per bin', () => {
    // Arrange
    const hour: MinuteHistory.Hour = {
      hourStartSeconds: SEPTEMBER_27_2026_10AM,
      dataTypes: ['orientation'],
      minutes: [minuteWith({ yawBin: 4, pitchBin: 8 }), ...allInvalid().slice(1)],
    }

    // Act
    const [orientation] = MinuteHistory.toObservations(hour, 'ada-lovelace', WATCH)

    // Assert
    expect(orientation?.code).toEqual({
      coding: [
        {
          system: HEALTH_SERVICE_SYSTEM,
          code: 'HealthMinuteData.orientation',
          display: 'Pebble watch orientation',
        },
      ],
    })
    expect(
      orientation?.component?.map(({ code, valueSampledData }) => [
        code.coding[0]?.code,
        valueSampledData.origin.code,
        valueSampledData.factor,
        valueSampledData.data.split(' ')[0],
      ])
    ).toEqual([
      ['HealthMinuteData.orientation.yaw', 'deg', 22.5, '4'],
      ['HealthMinuteData.orientation.pitch', 'deg', 22.5, '8'],
    ])
  })

  it.each([
    [1, '650'],
    [2, '750'],
    [3, '850'],
    [4, '950'],
    [0, 'E'],
  ])('should record AmbientLightLevel %i as %s lux', (light, sample) => {
    const hour: MinuteHistory.Hour = {
      hourStartSeconds: SEPTEMBER_27_2026_10AM,
      dataTypes: ['ambientLight'],
      minutes: [minuteWith({ light }), minuteWith({ light: 1 }), ...allInvalid().slice(2)],
    }
    const [light_] = MinuteHistory.toObservations(hour, 'ada-lovelace', WATCH)
    expect(light_?.valueSampledData?.origin.code).toBe('lx')
    expect(light_?.valueSampledData?.data.split(' ')[0]).toBe(sample)
  })

  it.each([
    ['steps', 'http://loinc.org', '55423-8', '{steps}'],
    ['movement', HEALTH_SERVICE_SYSTEM, 'HealthMinuteData.vmc', '{counts}/min'],
  ] as const)('should code %s as %s %s in %s', (dataType, system, code, unit) => {
    const hour: MinuteHistory.Hour = {
      hourStartSeconds: SEPTEMBER_27_2026_10AM,
      dataTypes: [dataType],
      minutes: [minuteWith({}), ...allInvalid().slice(1)],
    }
    const [observation] = MinuteHistory.toObservations(hour, 'ada-lovelace', WATCH)
    expect([
      observation?.code.coding[0]?.system,
      observation?.code.coding[0]?.code,
      observation?.valueSampledData?.origin.code,
    ]).toEqual([system, code, unit])
  })

  it('should always write Observations the FHIR R4 schema accepts', () => {
    fc.assert(
      fc.property(hourArbitrary, fc.string({ minLength: 1 }), (hour, patientId) => {
        for (const observation of MinuteHistory.toObservations(hour, patientId, WATCH)) {
          expect(() => Schema.decodeUnknownSync(Observation.Schema)(observation)).not.toThrow()
        }
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should always sample all 60 minutes, E for every invalid one', () => {
    fc.assert(
      fc.property(hourArbitrary, (hour) => {
        for (const sampledData of MinuteHistory.toObservations(hour, 'ada-lovelace', WATCH).flatMap(
          sampledDataOf
        )) {
          const samples = sampledData.data.split(' ')
          expect(samples).toHaveLength(60)
          hour.minutes.forEach((minute, index) => {
            if (minute === null) {
              expect(samples[index]).toBe('E')
            }
          })
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should span exactly the hour', () => {
    fc.assert(
      fc.property(hourArbitrary, (hour) => {
        for (const { effectivePeriod } of MinuteHistory.toObservations(
          hour,
          'ada-lovelace',
          WATCH
        )) {
          expect([
            Date.parse(effectivePeriod.start) / 1000,
            Date.parse(effectivePeriod.end) / 1000,
          ]).toEqual([hour.hourStartSeconds, hour.hourStartSeconds + 3600])
        }
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should never record a type with no sample that hour', () => {
    fc.assert(
      fc.property(hourArbitrary, (hour) => {
        const allInvalidHour = { ...hour, minutes: allInvalid() }
        expect(MinuteHistory.toObservations(allInvalidHour, 'ada-lovelace', WATCH)).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should record every requested type once when each minute has every sample', () => {
    fc.assert(
      fc.property(
        hourArbitrary,
        fc.array(fullMinuteArbitrary, { minLength: 60, maxLength: 60 }),
        (hour, minutes) => {
          const observations = MinuteHistory.toObservations(
            { ...hour, minutes },
            'ada-lovelace',
            WATCH
          )
          expect(observations).toHaveLength(hour.dataTypes.length)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

// Helpers

/** 2026-09-27T10:00:00Z. */
const SEPTEMBER_27_2026_10AM = 1_790_503_200

const WATCH: WatchDevice.Reference = WatchDevice.toReference(
  {
    platform: 'emery',
    model: 'pebble_time_2_black',
    firmware: { major: 4, minor: 9, patch: 1, suffix: '' },
  },
  '0123456789abcdef0123456789abcdef'
)

/** The minute types in `DataType` order, with their bit. */
const MINUTE_TYPE_BITS: ReadonlyArray<readonly [MinuteHistory.DataType, number]> = [
  ['heartRate', 1],
  ['steps', 2],
  ['orientation', 3],
  ['movement', 4],
  ['ambientLight', 5],
]

const typeBitsOf = (dataTypes: ReadonlyArray<MinuteHistory.DataType>): number =>
  MINUTE_TYPE_BITS.reduce(
    (bits, [dataType, bit]) => (dataTypes.includes(dataType) ? bits | (1 << bit) : bits),
    0
  )

const allInvalid = (): Array<MinuteHistory.Minute | null> => Array.from({ length: 60 }, () => null)

const minuteWith = (fields: Partial<MinuteHistory.Minute>): MinuteHistory.Minute => ({
  steps: 30,
  yawBin: 0,
  pitchBin: 4,
  vmc: 500,
  light: 2,
  heartRateBpm: 80,
  ...fields,
})

/** Lays minutes out as src/c/minute-wire.h does. */
const packMinutes = (minutes: ReadonlyArray<MinuteHistory.Minute | null>): Array<number> =>
  minutes.flatMap((minute) =>
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
  )

const hourPayload = (
  hourStartSeconds: number,
  typeBits: number,
  minutes: ReadonlyArray<MinuteHistory.Minute | null>
): Fields => ({
  MinuteHourStart: hourStartSeconds,
  MinuteTypes: typeBits,
  MinuteData: packMinutes(minutes),
})

/** Every MinuteHistory.SampledData in the Observation: its value, or each component's. */
const sampledDataOf = (
  observation: MinuteHistory.Observation
): Array<MinuteHistory.SampledData> => [
  ...(observation.valueSampledData === undefined ? [] : [observation.valueSampledData]),
  ...(observation.component ?? []).map(({ valueSampledData }) => valueSampledData),
]

const minuteArbitrary: fc.Arbitrary<MinuteHistory.Minute> = fc.record({
  steps: fc.integer({ min: 0, max: 255 }),
  yawBin: fc.integer({ min: 0, max: 15 }),
  pitchBin: fc.integer({ min: 0, max: 15 }),
  vmc: fc.integer({ min: 0, max: 65_535 }),
  light: fc.integer({ min: 0, max: 4 }),
  heartRateBpm: fc.integer({ min: 0, max: 255 }),
})

/** A minute every type has a sample for: a heart rate reading and a known light level. */
const fullMinuteArbitrary: fc.Arbitrary<MinuteHistory.Minute> = fc
  .tuple(minuteArbitrary, fc.integer({ min: 1, max: 255 }), fc.integer({ min: 1, max: 4 }))
  .map(([minute, heartRateBpm, light]) => ({ ...minute, heartRateBpm, light }))

const hourArbitrary: fc.Arbitrary<MinuteHistory.Hour> = fc.record({
  // Hours whose seconds fit the watch's int32 time.
  hourStartSeconds: fc
    .integer({ min: 0, max: Math.floor((2 ** 31 - 1) / 3600) })
    .map((hours) => hours * 3600),
  dataTypes: fc.subarray(
    MINUTE_TYPE_BITS.map(([dataType]) => dataType),
    { minLength: 1 }
  ),
  minutes: fc.array(fc.option(minuteArbitrary, { nil: null }), { minLength: 60, maxLength: 60 }),
})
