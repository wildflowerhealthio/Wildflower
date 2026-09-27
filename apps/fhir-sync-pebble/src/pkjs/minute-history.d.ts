// Types for minute-history.js: its JSDoc and test/minute-history.test.ts read
// them. The Pebble bundle only picks up *.js and *.json, so this file never
// reaches the phone.

import type { Coding } from './health-activity.js'

/** A menu data type the minute history carries. */
type MinuteDataType = 'heartRate' | 'steps' | 'orientation' | 'movement' | 'ambientLight'

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
interface MinuteHour {
  /** Unix seconds, on the hour. */
  readonly hourStartSeconds: number
  /** The minute types to post for this hour, in `DataType` order. */
  readonly dataTypes: ReadonlyArray<MinuteDataType>
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

/** How one minute type other than orientation becomes an Observation. */
interface SampledType {
  readonly category: Coding | null
  readonly code: ObservationCode
  readonly unit: Unit
  /** The minute's sample, or null when it has none. */
  readonly sample: (minute: Minute) => number | null
}

/**
 * The Observation one minute type becomes for an hour: `valueSampledData`, or
 * for orientation a yaw and a pitch `component`. The optional fields are
 * filled in after construction.
 */
interface MinuteObservation {
  readonly resourceType: 'Observation'
  readonly status: 'final'
  category?: ReadonlyArray<{ readonly coding: ReadonlyArray<Coding> }>
  readonly code: ObservationCode
  readonly subject: { readonly reference: string }
  readonly effectivePeriod: { readonly start: string; readonly end: string }
  valueSampledData?: SampledData
  component?: ReadonlyArray<{
    readonly code: ObservationCode
    readonly valueSampledData: SampledData
  }>
  readonly device: { readonly display: string }
}

declare function decodeMinuteHourCount(payload: object): number
declare function decodeMinuteHourMessage(payload: object): MinuteHour
declare function toObservations(
  hour: MinuteHour,
  patientId: string,
  watchDisplay: string
): Array<MinuteObservation>

export { decodeMinuteHourCount, decodeMinuteHourMessage, toObservations }
export type {
  Minute,
  MinuteDataType,
  MinuteHour,
  MinuteObservation,
  ObservationCode,
  SampledData,
  SampledType,
  Unit,
}
