import { Schema } from 'effect'
import * as fc from 'fast-check'
import { Observation } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

// PebbleKit JS is CommonJS, which vite.config.ts hands to Node's own loader;
// the sibling .d.ts files type it.
import { HEALTH_SERVICE_SYSTEM } from '../src/pkjs/health-activity.js'
import {
  decodeMinuteHourCount,
  decodeMinuteHourMessage,
  type Minute,
  type MinuteDataType,
  type MinuteHour,
  type MinuteObservation,
  type SampledData,
  toObservations,
} from '../src/pkjs/minute-history.js'

describe('decodeMinuteHourMessage', () => {
  it('decodes an hour with one valid minute', () => {
    // Arrange
    const minutes = [
      { steps: 12, yawBin: 4, pitchBin: 2, vmc: 300, light: 3, heartRateBpm: 72 },
      ...Array.from({ length: 59 }, () => null),
    ]
    const payload = hourPayload(SEPTEMBER_27_2026_10AM, 0b1010, minutes)

    // Act
    const hour = decodeMinuteHourMessage(payload)

    // Assert
    expect(hour).toEqual({
      hourStartSeconds: SEPTEMBER_27_2026_10AM,
      dataTypes: ['heartRate', 'orientation'],
      minutes,
    })
  })

  it('decodes whatever hour, types and minutes the watch packs', () => {
    fc.assert(
      fc.property(hourArbitrary, (hour) => {
        const payload = hourPayload(hour.hourStartSeconds, typeBitsOf(hour.dataTypes), hour.minutes)
        expect(decodeMinuteHourMessage(payload)).toEqual(hour)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects an hour start that is not on the hour', () => {
    fc.assert(
      fc.property(hourArbitrary, fc.integer({ min: 1, max: 3599 }), (hour, offset) => {
        const payload = hourPayload(
          hour.hourStartSeconds + offset,
          typeBitsOf(hour.dataTypes),
          hour.minutes
        )
        expect(() => decodeMinuteHourMessage(payload)).toThrow('MinuteHourStart')
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it.each([
    ['no type', 0],
    ['Health Activity, which is not a minute type', 0b1],
    ['a bit past the last data type', 0b1000000],
    ['a negative mask', -2],
  ])('rejects MinuteTypes with %s', (_, typeBits) => {
    const payload = hourPayload(SEPTEMBER_27_2026_10AM, typeBits, allInvalid())
    expect(() => decodeMinuteHourMessage(payload)).toThrow('MinuteTypes')
  })

  it('rejects MinuteData that is not 360 bytes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 })).filter((bytes) => bytes.length !== 360),
        (bytes) => {
          const payload = {
            MinuteHourStart: SEPTEMBER_27_2026_10AM,
            MinuteTypes: 0b10,
            MinuteData: bytes,
          }
          expect(() => decodeMinuteHourMessage(payload)).toThrow('MinuteData')
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it.each([
    ['above 255', 256],
    ['negative', -1],
    ['fractional', 0.5],
  ])('rejects MinuteData holding a value %s', (_, value) => {
    const bytes: Array<number> = packMinutes(allInvalid())
    bytes[7] = value
    const payload = {
      MinuteHourStart: SEPTEMBER_27_2026_10AM,
      MinuteTypes: 0b10,
      MinuteData: bytes,
    }
    expect(() => decodeMinuteHourMessage(payload)).toThrow('MinuteData')
  })
})

describe('decodeMinuteHourCount', () => {
  it('decodes any count of hours', () => {
    fc.assert(
      fc.property(fc.nat(), (count) => {
        expect(decodeMinuteHourCount({ MinuteHourCount: count })).toBe(count)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('rejects a negative, fractional or missing count', () => {
    for (const count of [-1, 0.5, undefined]) {
      expect(() => decodeMinuteHourCount({ MinuteHourCount: count })).toThrow('MinuteHourCount')
    }
  })
})

describe('toObservations', () => {
  it('records an hour of heart rate as per-minute samples, E where there was no reading', () => {
    // Arrange
    const hour: MinuteHour = {
      hourStartSeconds: SEPTEMBER_27_2026_10AM,
      dataTypes: ['heartRate'],
      minutes: [
        minuteWith({ heartRateBpm: 72 }),
        minuteWith({ heartRateBpm: 0 }),
        ...allInvalid().slice(2),
      ],
    }

    // Act
    const observations = toObservations(hour, 'ada-lovelace', WATCH)

    // Assert
    expect(observations).toEqual([
      {
        resourceType: 'Observation',
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
        device: { display: WATCH },
      },
    ])
  })

  it('records orientation as yaw and pitch components in degrees, 22.5 per bin', () => {
    // Arrange
    const hour: MinuteHour = {
      hourStartSeconds: SEPTEMBER_27_2026_10AM,
      dataTypes: ['orientation'],
      minutes: [minuteWith({ yawBin: 4, pitchBin: 8 }), ...allInvalid().slice(1)],
    }

    // Act
    const [orientation] = toObservations(hour, 'ada-lovelace', WATCH)

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
  ])('records AmbientLightLevel %i as %s lux', (light, sample) => {
    const hour: MinuteHour = {
      hourStartSeconds: SEPTEMBER_27_2026_10AM,
      dataTypes: ['ambientLight'],
      minutes: [minuteWith({ light }), minuteWith({ light: 1 }), ...allInvalid().slice(2)],
    }
    const [light_] = toObservations(hour, 'ada-lovelace', WATCH)
    expect(light_?.valueSampledData?.origin.code).toBe('lx')
    expect(light_?.valueSampledData?.data.split(' ')[0]).toBe(sample)
  })

  it.each([
    ['steps', 'http://loinc.org', '55423-8', '{steps}'],
    ['movement', HEALTH_SERVICE_SYSTEM, 'HealthMinuteData.vmc', '{counts}/min'],
  ] as const)('codes %s as %s %s in %s', (dataType, system, code, unit) => {
    const hour: MinuteHour = {
      hourStartSeconds: SEPTEMBER_27_2026_10AM,
      dataTypes: [dataType],
      minutes: [minuteWith({}), ...allInvalid().slice(1)],
    }
    const [observation] = toObservations(hour, 'ada-lovelace', WATCH)
    expect([
      observation?.code.coding[0]?.system,
      observation?.code.coding[0]?.code,
      observation?.valueSampledData?.origin.code,
    ]).toEqual([system, code, unit])
  })

  it('always writes Observations the FHIR R4 schema accepts', () => {
    fc.assert(
      fc.property(hourArbitrary, fc.string({ minLength: 1 }), (hour, patientId) => {
        for (const observation of toObservations(hour, patientId, WATCH)) {
          expect(() => Schema.decodeUnknownSync(Observation.Schema)(observation)).not.toThrow()
        }
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('always samples all 60 minutes, E for every invalid one', () => {
    fc.assert(
      fc.property(hourArbitrary, (hour) => {
        for (const sampledData of toObservations(hour, 'ada-lovelace', WATCH).flatMap(
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

  it('spans exactly the hour', () => {
    fc.assert(
      fc.property(hourArbitrary, (hour) => {
        for (const { effectivePeriod } of toObservations(hour, 'ada-lovelace', WATCH)) {
          expect([
            Date.parse(effectivePeriod.start) / 1000,
            Date.parse(effectivePeriod.end) / 1000,
          ]).toEqual([hour.hourStartSeconds, hour.hourStartSeconds + 3600])
        }
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('never records a type with no sample that hour', () => {
    fc.assert(
      fc.property(hourArbitrary, (hour) => {
        const allInvalidHour = { ...hour, minutes: allInvalid() }
        expect(toObservations(allInvalidHour, 'ada-lovelace', WATCH)).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('records every requested type once when each minute has every sample', () => {
    fc.assert(
      fc.property(
        hourArbitrary,
        fc.array(fullMinuteArbitrary, { minLength: 60, maxLength: 60 }),
        (hour, minutes) => {
          const observations = toObservations({ ...hour, minutes }, 'ada-lovelace', WATCH)
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

const WATCH = 'pebble_time_2_black (emery, firmware 4.9.1)'

/** The minute types in `DataType` order, with their bit. */
const MINUTE_TYPE_BITS: ReadonlyArray<readonly [MinuteDataType, number]> = [
  ['heartRate', 1],
  ['steps', 2],
  ['orientation', 3],
  ['movement', 4],
  ['ambientLight', 5],
]

const typeBitsOf = (dataTypes: ReadonlyArray<MinuteDataType>): number =>
  MINUTE_TYPE_BITS.reduce(
    (bits, [dataType, bit]) => (dataTypes.includes(dataType) ? bits | (1 << bit) : bits),
    0
  )

const allInvalid = (): Array<Minute | null> => Array.from({ length: 60 }, () => null)

const minuteWith = (fields: Partial<Minute>): Minute => ({
  steps: 30,
  yawBin: 0,
  pitchBin: 4,
  vmc: 500,
  light: 2,
  heartRateBpm: 80,
  ...fields,
})

/** Lays minutes out as src/c/minute-wire.h does. */
const packMinutes = (minutes: ReadonlyArray<Minute | null>): Array<number> =>
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
  minutes: ReadonlyArray<Minute | null>
): object => ({
  MinuteHourStart: hourStartSeconds,
  MinuteTypes: typeBits,
  MinuteData: packMinutes(minutes),
})

/** Every SampledData in the Observation: its value, or each component's. */
const sampledDataOf = (observation: MinuteObservation): Array<SampledData> => [
  ...(observation.valueSampledData === undefined ? [] : [observation.valueSampledData]),
  ...(observation.component ?? []).map(({ valueSampledData }) => valueSampledData),
]

const minuteArbitrary: fc.Arbitrary<Minute> = fc.record({
  steps: fc.integer({ min: 0, max: 255 }),
  yawBin: fc.integer({ min: 0, max: 15 }),
  pitchBin: fc.integer({ min: 0, max: 15 }),
  vmc: fc.integer({ min: 0, max: 65_535 }),
  light: fc.integer({ min: 0, max: 4 }),
  heartRateBpm: fc.integer({ min: 0, max: 255 }),
})

/** A minute every type has a sample for: a heart rate reading and a known light level. */
const fullMinuteArbitrary: fc.Arbitrary<Minute> = fc
  .tuple(minuteArbitrary, fc.integer({ min: 1, max: 255 }), fc.integer({ min: 1, max: 4 }))
  .map(([minute, heartRateBpm, light]) => ({ ...minute, heartRateBpm, light }))

const hourArbitrary: fc.Arbitrary<MinuteHour> = fc.record({
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
