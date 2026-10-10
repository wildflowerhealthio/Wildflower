import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MinuteHistory } from '@wildflowerhealthio/fhir-sync-pebble-core/pkjs'
import {
  buildHostCDriver,
  type HostCDriver,
  numRunsFor,
} from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

// minute-wire.c packs each minute of HealthMinuteData for the phone, and
// fhir-sync-pebble-core's MinuteHistory unpacks it. The watch side needs no
// SDK to test: buildHostCDriver compiles it with the host C compiler under the
// sanitizers, driven through minute-wire-driver.c, and these tests feed its
// bytes to the phone's decoder to hold the two sides of the wire together.
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')

let driver: HostCDriver
/** MINUTE_WIRE_SIZE and MINUTE_WIRE_HOUR_MINUTES from minute-wire.h. */
let minuteWireSize: number
let minutesPerHour: number

beforeAll(() => {
  driver = buildHostCDriver({
    name: 'fhir-sync-pebble-minute-wire',
    sources: [
      join(packageDir, 'test/minute-wire-driver.c'),
      join(packageDir, 'src/c/minute-wire.c'),
    ],
  })
  ;[minuteWireSize = 0, minutesPerHour = 0] = driver.run('sizes').split(' ').map(Number)
})

afterAll(() => {
  driver.dispose()
})

describe('minute_wire_pack', () => {
  it('lays a minute out as steps, orientation, vmc (little-endian), flags and heart rate', () => {
    // Arrange: yaw bin 4 and pitch bin 2 make orientation 0x24; light 3 sits in flag bits 1-3.
    const command = 'pack 12 36 4660 0 3 72'

    // Act
    const bytes = driver.run(command)

    // Assert
    expect(bytes).toBe('12 36 52 18 6 72')
  })

  it('sets flag bit 0 for an invalid minute', () => {
    expect(driver.run('pack 0 0 0 1 0 0')).toBe('0 0 0 0 1 0')
  })

  it('packs any minute into bytes the phone decodes back to the same fields', () => {
    fc.assert(
      fc.property(packedFieldsArbitrary, fc.integer({ min: 0, max: 59 }), (fields, minuteIndex) => {
        // Arrange: the packed minute among otherwise invalid ones.
        const minuteBytes = driver.run(packCommand(fields)).split(' ').map(Number)
        const invalidBytes = driver.run('pack 0 0 0 1 0 0').split(' ').map(Number)
        const hourBytes = Array.from({ length: minutesPerHour }, (_, index) =>
          index === minuteIndex ? minuteBytes : invalidBytes
        ).flat()

        // Act
        const hour = MinuteHistory.decodeHourMessage({
          MinuteHourStart: 0,
          MinuteTypes: 0b10,
          MinuteData: hourBytes,
        })

        // Assert
        expect(hourBytes).toHaveLength(minuteWireSize * minutesPerHour)
        expect(hour.minutes[minuteIndex]).toEqual(fields.invalid ? null : expectedMinute(fields))
      }),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })
})

// Helpers

/** Everything `minute_wire_pack` takes, orientation split into its bins. */
interface PackedFields {
  readonly steps: number
  readonly yawBin: number
  readonly pitchBin: number
  readonly vmc: number
  readonly invalid: boolean
  readonly light: number
  readonly heartRateBpm: number
}

const packedFieldsArbitrary: fc.Arbitrary<PackedFields> = fc.record({
  steps: fc.integer({ min: 0, max: 255 }),
  yawBin: fc.integer({ min: 0, max: 15 }),
  pitchBin: fc.integer({ min: 0, max: 15 }),
  vmc: fc.integer({ min: 0, max: 65_535 }),
  invalid: fc.boolean(),
  // An AmbientLightLevel.
  light: fc.integer({ min: 0, max: 4 }),
  heartRateBpm: fc.integer({ min: 0, max: 255 }),
})

const packCommand = (fields: PackedFields): string =>
  [
    'pack',
    fields.steps,
    fields.yawBin | (fields.pitchBin << 4),
    fields.vmc,
    fields.invalid ? 1 : 0,
    fields.light,
    fields.heartRateBpm,
  ].join(' ')

const expectedMinute = ({
  steps,
  yawBin,
  pitchBin,
  vmc,
  light,
  heartRateBpm,
}: PackedFields): MinuteHistory.Minute => ({
  steps,
  yawBin,
  pitchBin,
  vmc,
  light,
  heartRateBpm,
})
