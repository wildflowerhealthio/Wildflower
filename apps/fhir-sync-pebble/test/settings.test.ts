import { Arbitrary } from 'effect'
import * as fc from 'fast-check'
import * as PebbleSettings from 'fhir-sync-pebble-web/pebble-settings'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

// PebbleKit JS is CommonJS, which vite.config.ts hands to Node's own loader;
// settings.d.ts types it.
import { decodeResponse, toWatchMessage } from '../src/pkjs/settings.js'

const settingsArbitrary = Arbitrary.make(PebbleSettings.Schema)

/** The `webviewclosed` response for `json`, as the configuration page hands it back. */
const responseFor = (json: string): string => encodeURIComponent(json)

const REQUIRED_KEYS = ['patientId', 'accessToken', 'fhirBaseUrl'] as const
const NULLABLE_KEYS = ['patientName', 'patientBirthDate'] as const

describe('decodeResponse', () => {
  // The wire contract: what the configuration page's toJson writes is what
  // the watchapp decodes, field for field.
  it('decodes whatever the configuration page saves', () => {
    fc.assert(
      fc.property(settingsArbitrary, (settings) => {
        expect(decodeResponse(responseFor(PebbleSettings.toJson(settings)))).toEqual(settings)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('drops fields the settings do not carry', () => {
    fc.assert(
      fc.property(settingsArbitrary, fc.string(), (settings, extra) => {
        const json = JSON.stringify({ ...settings, extra })
        expect(decodeResponse(responseFor(json))).toEqual(settings)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it.each(REQUIRED_KEYS)('rejects settings whose %s is missing, empty or not a string', (key) => {
    fc.assert(
      fc.property(
        settingsArbitrary,
        fc.constantFrom<unknown>(undefined, '', null, 0, true, {}),
        (settings, value) => {
          const json = JSON.stringify({ ...settings, [key]: value })
          expect(() => decodeResponse(responseFor(json))).toThrow(key)
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it.each(NULLABLE_KEYS)('rejects settings whose %s is missing or not a string', (key) => {
    fc.assert(
      fc.property(
        settingsArbitrary,
        fc.constantFrom<unknown>(undefined, 0, true, {}),
        (settings, value) => {
          const json = JSON.stringify({ ...settings, [key]: value })
          expect(() => decodeResponse(responseFor(json))).toThrow(key)
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('rejects JSON that is not an object', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.array(fc.jsonValue()),
          fc.string(),
          fc.double({ noNaN: true }),
          fc.constant(null)
        ),
        (value) => {
          expect(() => decodeResponse(responseFor(JSON.stringify(value)))).toThrow()
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('rejects a response that is not JSON', () => {
    expect(() => decodeResponse(responseFor('{"patientId":'))).toThrow()
  })
})

describe('toWatchMessage', () => {
  it('sends the name and birth date, empty for none, and the receipt time in seconds', () => {
    fc.assert(
      fc.property(
        settingsArbitrary,
        fc.nat({ max: 4_102_444_800_000 }),
        (settings, receivedAtMs) => {
          expect(toWatchMessage(settings, receivedAtMs)).toEqual({
            PatientName: settings.patientName ?? '',
            PatientBirthDate: settings.patientBirthDate ?? '',
            AuthTime: Math.floor(receivedAtMs / 1000),
          })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
