import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fc from 'fast-check'
import { PhoneSettings } from 'fhir-sync-pebble-core/pkjs'
import { buildHostCDriver, type HostCDriver, numRunsFor } from 'kitchen-sink/test'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

// state.c keeps the watch's connection and last-sync times in persist
// storage. It includes pebble.h, so buildHostCDriver builds it against the
// stand-in in pebble-stand-in/, whose persist storage state-driver.c keeps in
// memory for one scenario (one driver command line) at a time.
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')

let driver: HostCDriver
/** DATA_TYPE_COUNT and the limits state.h sets, read from the driver in beforeAll. */
let dataTypeCount: number
let patientNameSize: number
let birthDateSize: number
let connectionIdSize: number
let appMessageInboxSize: number

beforeAll(() => {
  driver = buildHostCDriver({
    name: 'fhir-sync-pebble-state',
    sources: [join(packageDir, 'test/state-driver.c'), join(packageDir, 'src/c/state.c')],
    includeDirectories: [join(packageDir, 'test/pebble-stand-in')],
  })
  ;[
    dataTypeCount = 0,
    patientNameSize = 0,
    birthDateSize = 0,
    connectionIdSize = 0,
    appMessageInboxSize = 0,
  ] = driver.run('sizes').split(' ').map(Number)
})

afterAll(() => {
  driver.dispose()
})

/** Runs `steps` as one scenario and returns each step's output. */
const runScenario = (steps: ReadonlyArray<string>): string => driver.run(steps.join('; '))

/** A connection id as the phone sends one: `wf-` and 32 hex digits. */
const connectionIdArbitrary = fc.stringMatching(/^[0-9a-f]{32}$/).map((hex) => `wf-${hex}`)

/**
 * A successful sync's start, then each data type's synced_through: on the
 * hour, none 0. A function because the type count comes from the driver.
 */
const completedSyncArbitrary = (): fc.Arbitrary<Array<number>> =>
  fc
    .array(fc.integer({ min: 1, max: 500_000 }), {
      minLength: 1 + dataTypeCount,
      maxLength: 1 + dataTypeCount,
    })
    .map((hours) => hours.map((hour) => hour * 3600))

const syncTimesText = (times: ReadonlyArray<number>): string => times.join(' ')

/** What `times` prints before any sync: the overall and every data type's time, 0. */
const neverSynced = (): string => syncTimesText(Array.from({ length: 1 + dataTypeCount }, () => 0))

const NUM_RUNS = numRunsFor({ base: 25 })

describe('state_set_connection', () => {
  it('should keep the last-sync times across a sign-in again to the same patient', () => {
    fc.assert(
      fc.property(connectionIdArbitrary, completedSyncArbitrary(), (connectionId, times) => {
        expect(
          runScenario([
            `connect ${connectionId} 100`,
            `complete ${syncTimesText(times)}`,
            `connect ${connectionId} 200`,
            'times',
            'restart',
            'times',
            'connection',
          ])
        ).toBe(
          [
            'reset done kept',
            syncTimesText(times),
            'loaded',
            syncTimesText(times),
            `1 ${connectionId} 200`,
          ].join(' ')
        )
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('should start the last-sync times over for another patient or server, and persist that', () => {
    fc.assert(
      fc.property(
        connectionIdArbitrary,
        connectionIdArbitrary,
        completedSyncArbitrary(),
        (firstConnectionId, secondConnectionId, times) => {
          fc.pre(firstConnectionId !== secondConnectionId)
          expect(
            runScenario([
              `connect ${firstConnectionId} 100`,
              `complete ${syncTimesText(times)}`,
              `connect ${secondConnectionId} 200`,
              'times',
              'restart',
              'times',
              'connection',
            ])
          ).toBe(
            [
              'reset done reset',
              neverSynced(),
              'loaded',
              neverSynced(),
              `1 ${secondConnectionId} 200`,
            ].join(' ')
          )
        }
      ),
      { numRuns: NUM_RUNS }
    )
  })

  it('should start over on the first connection', () => {
    expect(runScenario(['connection', 'connect wf-0 100', 'times'])).toBe(
      `0  0 reset ${neverSynced()}`
    )
  })

  it('should keep the connection id across a restart', () => {
    expect(runScenario(['connect wf-0 100', 'restart', 'connect wf-0 200'])).toBe(
      'reset loaded kept'
    )
  })
})

// The settings message is the largest the phone sends; the watch drops one
// too big for its inbox. The phone cuts the name and birth date to what
// state.h keeps, and this holds the two sides together.
describe('the settings message', () => {
  /** A Pebble dictionary's bytes: a count byte, then per tuple a 7-byte header and its value. */
  const dictionarySize = (message: PhoneSettings.WatchMessage): number =>
    1 +
    Object.values(message).reduce<number>(
      (size, value) =>
        size + 7 + (typeof value === 'number' ? 4 : Buffer.byteLength(value, 'utf8') + 1),
      0
    )

  const longTextArbitrary = fc
    .array(fc.constantFrom('a', 'é', '日', '😀'), { minLength: 0, maxLength: 200 })
    .map((characters) => characters.join(''))

  it("should fit state.h's fields and the watch's inbox, whatever the settings", () => {
    fc.assert(
      fc.property(
        longTextArbitrary,
        longTextArbitrary,
        fc.string({ minLength: 1, maxLength: 300 }),
        fc.string({ minLength: 1, maxLength: 300 }),
        (patientName, patientBirthDate, patientId, fhirBaseUrl) => {
          // Act
          const message = PhoneSettings.toWatchMessage(
            { patientId, patientName, patientBirthDate, accessToken: 'token', fhirBaseUrl },
            Date.now()
          )

          // Assert
          expect(Buffer.byteLength(message.PatientName, 'utf8')).toBeLessThan(patientNameSize)
          expect(Buffer.byteLength(message.PatientBirthDate, 'utf8')).toBeLessThan(birthDateSize)
          expect(message.ConnectionId).toHaveLength(connectionIdSize - 1)
          expect(dictionarySize(message)).toBeLessThanOrEqual(appMessageInboxSize)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
