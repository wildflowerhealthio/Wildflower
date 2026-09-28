import { requireInteger, requirePayload } from './fields.ts'
import {
  ACTIVITY_CATEGORY_CODING,
  type Coding,
  HEALTH_SERVICE_SYSTEM,
  toDateTime,
} from './health-activity.ts'
import { observationId, type Reference } from './watch-device.ts'

/**
 * Minute history: the watch's hour messages in, one Observation per minute
 * type per hour out, each minute a sample of its `valueSampledData`.
 *
 * @remarks
 * A namespace module — consumers speak `MinuteHistory.Hour`,
 * `MinuteHistory.decodeHourMessage`, `MinuteHistory.toObservations`. Each hour
 * message carries `MinuteHourStart`, `MinuteTypes` and `MinuteData`, 60
 * minutes laid out as `apps/fhir-sync-pebble/src/c/minute-wire.h` packs them;
 * the message ending the sync carries `MinuteHourCount`. The conversions follow
 * the Core Devices PebbleOS sources; `apps/fhir-sync-pebble/AGENTS.md` tabulates
 * them.
 *
 * @packageDocumentation
 */

const SECONDS_PER_HOUR = 3600
const MILLISECONDS_PER_MINUTE = 60_000

/** Minutes per hour message, and the bytes each takes (src/c/minute-wire.h). */
const MINUTES_PER_HOUR = 60
const MINUTE_WIRE_SIZE = 6

const LOINC = 'http://loinc.org'
const UCUM = 'http://unitsofmeasure.org'

const VITAL_SIGNS_CATEGORY_CODING: Coding = {
  system: 'http://terminology.hl7.org/CodeSystem/observation-category',
  code: 'vital-signs',
  display: 'Vital Signs',
}

/**
 * A menu data type the minute history carries. Each name is part of its
 * Observations' ids (see {@link toObservations}): never change one.
 */
type DataType = 'heartRate' | 'steps' | 'orientation' | 'movement' | 'ambientLight'

/**
 * The minute types by their bit in `MinuteTypes`, which is their `DataType`
 * value in src/c/data-type.h. Bit 0, Health Activity, isn't a minute type.
 */
const DATA_TYPE_BITS: ReadonlyArray<readonly [number, DataType]> = [
  [1, 'heartRate'],
  [2, 'steps'],
  [3, 'orientation'],
  [4, 'movement'],
  [5, 'ambientLight'],
]

/** Bits 1 to 5: every minute type. */
const MINUTE_TYPE_BITS = 0x3e

/**
 * Approximate lux for each `AmbientLightLevel` above Unknown: the midpoint of
 * its band on the Pebble Time 2, whose firmware splits levels at 700, 800 and
 * 900 lux (dark threshold 800 ± 100). The outer bands are open-ended.
 */
const LIGHT_LEVEL_LUX: Readonly<Record<number, number>> = { 1: 650, 2: 750, 3: 850, 4: 950 }

/** Degrees per orientation bin: 16 bins around the full circle. */
const DEGREES_PER_ORIENTATION_BIN = 22.5

/** One valid minute of `HealthMinuteData`, as the watch sent it. */
interface Minute {
  readonly steps: number
  /** 0-15; bin n is n × 22.5° of yaw. */
  readonly yawBin: number
  /** 0-15, in practice 0-8; bin n is n × 22.5° from the watch's +z axis. */
  readonly pitchBin: number
  readonly vmc: number
  /** The `AmbientLightLevel`, 0 (Unknown) to 4 (VeryLight). */
  readonly light: number
  /** 0 when the watch had no reading. */
  readonly heartRateBpm: number
}

/** One hour of minute history, decoded from its AppMessage. */
interface Hour {
  /** Unix seconds, on the hour. */
  readonly hourStartSeconds: number
  /** The minute types to post for this hour, in `DataType` order. */
  readonly dataTypes: ReadonlyArray<DataType>
  /** 60 minutes, oldest first; null where the watch has no valid minute. */
  readonly minutes: ReadonlyArray<Minute | null>
}

/** A UCUM unit: its human name and its code. */
interface Unit {
  readonly unit: string
  readonly code: string
}

interface SampledData {
  readonly origin: {
    readonly value: 0
    readonly unit: string
    readonly system: string
    readonly code: string
  }
  /** Milliseconds between samples. */
  readonly period: number
  readonly factor: number
  readonly dimensions: 1
  /** Space-separated samples, `E` for none. */
  readonly data: string
}

interface ObservationCode {
  readonly coding: ReadonlyArray<Coding>
  readonly text?: string
}

/**
 * The Observation one minute type becomes for an hour: `valueSampledData`, or
 * for orientation a yaw and a pitch `component`.
 */
interface Observation {
  readonly resourceType: 'Observation'
  readonly id: string
  readonly status: 'final'
  readonly category?: ReadonlyArray<{ readonly coding: ReadonlyArray<Coding> }>
  readonly code: ObservationCode
  readonly subject: { readonly reference: string }
  readonly effectivePeriod: { readonly start: string; readonly end: string }
  readonly valueSampledData?: SampledData
  readonly component?: ReadonlyArray<{
    readonly code: ObservationCode
    readonly valueSampledData: SampledData
  }>
  readonly device: Reference
}

/** How one minute type other than orientation becomes an Observation. */
interface SampledType {
  readonly category: Coding | null
  readonly code: ObservationCode
  readonly unit: Unit
  /** The minute's sample, or null when it has none. */
  readonly sample: (minute: Minute) => number | null
}

/** The Observation each minute type becomes, except orientation's two angles. */
const SAMPLED_TYPES: Readonly<Record<Exclude<DataType, 'orientation'>, SampledType>> = {
  heartRate: {
    category: VITAL_SIGNS_CATEGORY_CODING,
    code: { coding: [{ system: LOINC, code: '8867-4', display: 'Heart rate' }] },
    unit: { unit: 'beats/minute', code: '/min' },
    // 0 bpm is the watch's "no reading".
    sample: (minute) => (minute.heartRateBpm === 0 ? null : minute.heartRateBpm),
  },
  steps: {
    category: ACTIVITY_CATEGORY_CODING,
    code: {
      coding: [
        {
          system: LOINC,
          code: '55423-8',
          display: 'Number of steps in unspecified time Pedometer',
        },
      ],
    },
    unit: { unit: 'steps', code: '{steps}' },
    sample: (minute) => minute.steps,
  },
  movement: {
    category: ACTIVITY_CATEGORY_CODING,
    code: {
      coding: [
        {
          system: HEALTH_SERVICE_SYSTEM,
          code: 'HealthMinuteData.vmc',
          display: 'Pebble vector magnitude counts',
        },
      ],
    },
    unit: { unit: 'counts/minute', code: '{counts}/min' },
    sample: (minute) => minute.vmc,
  },
  ambientLight: {
    category: null,
    code: {
      coding: [
        {
          system: HEALTH_SERVICE_SYSTEM,
          code: 'HealthMinuteData.light',
          display: 'Pebble ambient light level',
        },
      ],
      text:
        'Pebble ambient light level as the midpoint of its lux band: 650 (very dark, under ' +
        '700 lx), 750 (dark), 850 (light) or 950 (very light, 900 lx and over)',
    },
    unit: { unit: 'lux', code: 'lx' },
    sample: (minute) =>
      Object.prototype.hasOwnProperty.call(LIGHT_LEVEL_LUX, minute.light)
        ? LIGHT_LEVEL_LUX[minute.light]
        : null,
  },
}

const ORIENTATION_CODE: ObservationCode = {
  coding: [
    {
      system: HEALTH_SERVICE_SYSTEM,
      code: 'HealthMinuteData.orientation',
      display: 'Pebble watch orientation',
    },
  ],
}

const DEGREES: Unit = { unit: 'degrees', code: 'deg' }

/** `values` when every one is a byte, or null when one is not. */
const asBytes = (values: ReadonlyArray<unknown>): ReadonlyArray<number> | null => {
  const checked: Array<number> = []
  for (const byte of values) {
    if (typeof byte !== 'number' || byte % 1 !== 0 || byte < 0 || byte > 255) {
      return null
    }
    checked.push(byte)
  }
  return checked
}

/** The minute at `offset` in an hour's bytes, or null when its invalid flag is set. */
const minuteAt = (bytes: ReadonlyArray<number>, offset: number): Minute | null => {
  const byteAt = (index: number): number => bytes[offset + index]
  const flags = byteAt(4)
  if ((flags & 1) !== 0) {
    return null
  }
  const orientation = byteAt(1)
  return {
    steps: byteAt(0),
    yawBin: orientation & 0xf,
    pitchBin: orientation >> 4,
    vmc: byteAt(2) | (byteAt(3) << 8),
    light: (flags >> 1) & 0x7,
    heartRateBpm: byteAt(5),
  }
}

/**
 * Decodes one hour of minute history from the watch: `MinuteHourStart` (Unix
 * seconds on the hour), `MinuteTypes` (the minute types to post, one bit per
 * `DataType`) and `MinuteData` (60 minutes of 6 bytes, laid out in
 * src/c/minute-wire.h). Throws when the message is not that shape.
 *
 * @param payload - The AppMessage payload, keyed by message key name
 */
const decodeHourMessage = (payload: unknown): Hour => {
  const fields = requirePayload(payload)
  const hourStartSeconds = requireInteger(fields, 'MinuteHourStart')
  if (hourStartSeconds % SECONDS_PER_HOUR !== 0) {
    throw new Error('Message field MinuteHourStart must be on the hour')
  }

  const typeBits = requireInteger(fields, 'MinuteTypes')
  if (typeBits <= 0 || typeBits > MINUTE_TYPE_BITS || (typeBits & ~MINUTE_TYPE_BITS) !== 0) {
    throw new Error('Message field MinuteTypes must set only minute type bits, at least one')
  }
  const dataTypes = DATA_TYPE_BITS.filter(([bit]) => (typeBits & (1 << bit)) !== 0).map(
    ([, dataType]) => dataType
  )

  const hourBytes = MINUTES_PER_HOUR * MINUTE_WIRE_SIZE
  const minuteData: unknown = fields['MinuteData']
  if (!Array.isArray(minuteData) || minuteData.length !== hourBytes) {
    throw new Error(`Message field MinuteData must be ${hourBytes} bytes`)
  }
  const bytes = asBytes(minuteData)
  if (bytes === null) {
    throw new Error('Message field MinuteData must hold bytes')
  }

  const minutes: Array<Minute | null> = []
  for (let minute = 0; minute < MINUTES_PER_HOUR; minute++) {
    minutes.push(minuteAt(bytes, minute * MINUTE_WIRE_SIZE))
  }
  return { hourStartSeconds, dataTypes, minutes }
}

/**
 * Decodes how many hour messages the watch sent this sync, from the message
 * ending it.
 *
 * @param payload - The AppMessage payload, keyed by message key name
 */
const decodeHourCount = (payload: unknown): number => {
  const count = requireInteger(requirePayload(payload), 'MinuteHourCount')
  if (count < 0) {
    throw new Error('Message field MinuteHourCount must not be negative')
  }
  return count
}

/** One sample per minute, in `unit`, each sample times `factor`; `E` where a minute has none. */
const toSampledData = (
  samples: ReadonlyArray<number | null>,
  unit: Unit,
  factor: number
): SampledData => ({
  origin: { value: 0, unit: unit.unit, system: UCUM, code: unit.code },
  period: MILLISECONDS_PER_MINUTE,
  factor,
  dimensions: 1,
  data: samples.map((sample) => (sample === null ? 'E' : String(sample))).join(' '),
})

const hasAnySample = (samples: ReadonlyArray<number | null>): boolean =>
  samples.some((sample) => sample !== null)

const samplesOf = (
  minutes: ReadonlyArray<Minute | null>,
  sample: (minute: Minute) => number | null
): Array<number | null> => minutes.map((minute) => (minute === null ? null : sample(minute)))

/**
 * The Observations for one hour: one per minute type the watch asked for,
 * except a type with no sample that hour, which gets none. Each one's id is the
 * watch's for its type and hour (`WatchDevice.observationId`), so an hour sent
 * again overwrites what it sent before. The record key (`'MinuteHistory'`, the
 * {@link DataType} name, the hour's start) is persisted wire format: never
 * change it, or the `DataType` names; changing either re-keys every
 * minute-history Observation.
 *
 * @param device - `WatchDevice.toReference`'s reference
 */
const toObservations = (hour: Hour, patientId: string, device: Reference): Array<Observation> => {
  const observationOf = (
    dataType: DataType,
    category: Coding | null,
    code: ObservationCode
  ): Observation => ({
    resourceType: 'Observation',
    id: observationId(device, patientId, [
      'MinuteHistory',
      dataType,
      String(hour.hourStartSeconds),
    ]),
    status: 'final',
    ...(category === null ? {} : { category: [{ coding: [category] }] }),
    code,
    subject: { reference: `Patient/${patientId}` },
    effectivePeriod: {
      start: toDateTime(hour.hourStartSeconds),
      end: toDateTime(hour.hourStartSeconds + SECONDS_PER_HOUR),
    },
    device,
  })

  const observationFor = (dataType: DataType): Observation | null => {
    if (dataType === 'orientation') {
      const yaw = samplesOf(hour.minutes, (minute) => minute.yawBin)
      const pitch = samplesOf(hour.minutes, (minute) => minute.pitchBin)
      if (!hasAnySample(yaw)) {
        return null
      }
      return {
        ...observationOf(dataType, ACTIVITY_CATEGORY_CODING, ORIENTATION_CODE),
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
            valueSampledData: toSampledData(yaw, DEGREES, DEGREES_PER_ORIENTATION_BIN),
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
            valueSampledData: toSampledData(pitch, DEGREES, DEGREES_PER_ORIENTATION_BIN),
          },
        ],
      }
    }
    const sampledType = SAMPLED_TYPES[dataType]
    const samples = samplesOf(hour.minutes, sampledType.sample)
    if (!hasAnySample(samples)) {
      return null
    }
    return {
      ...observationOf(dataType, sampledType.category, sampledType.code),
      valueSampledData: toSampledData(samples, sampledType.unit, 1),
    }
  }

  const observations: Array<Observation> = []
  for (const dataType of hour.dataTypes) {
    const observation = observationFor(dataType)
    if (observation !== null) {
      observations.push(observation)
    }
  }
  return observations
}

export { decodeHourCount, decodeHourMessage, toObservations }
export type { DataType, Hour, Minute, Observation, ObservationCode, SampledData, Unit }
