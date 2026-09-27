import { Arbitrary } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as PebbleSettings from './pebble-settings.ts'
import * as PhoneSettings from './phone-settings.ts'

const settingsArbitrary = Arbitrary.make(PebbleSettings.Schema)

/** The `webviewclosed` response for `json`, as the configuration page hands it back. */
const responseFor = (json: string): string => encodeURIComponent(json)

const REQUIRED_KEYS = ['patientId', 'accessToken', 'fhirBaseUrl'] as const
const NULLABLE_KEYS = ['patientName', 'patientBirthDate'] as const

describe('decodeResponse', () => {
  // The wire contract: what the configuration page's toJson writes is what
  // the watchapp decodes, field for field.
  it('should decode whatever the configuration page saves', () => {
    fc.assert(
      fc.property(settingsArbitrary, (settings) => {
        expect(PhoneSettings.decodeResponse(responseFor(PebbleSettings.toJson(settings)))).toEqual(
          settings
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should drop fields the settings do not carry', () => {
    fc.assert(
      fc.property(settingsArbitrary, fc.string(), (settings, extra) => {
        const json = JSON.stringify({ ...settings, extra })
        expect(PhoneSettings.decodeResponse(responseFor(json))).toEqual(settings)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it.each(REQUIRED_KEYS)(
    'should reject settings whose %s is missing, empty or not a string',
    (key) => {
      fc.assert(
        fc.property(
          settingsArbitrary,
          fc.constantFrom<unknown>(undefined, '', null, 0, true, {}),
          (settings, value) => {
            const json = JSON.stringify({ ...settings, [key]: value })
            expect(() => PhoneSettings.decodeResponse(responseFor(json))).toThrow(key)
          }
        ),
        { numRuns: numRunsFor({ base: 30 }) }
      )
    }
  )

  it.each(NULLABLE_KEYS)('should reject settings whose %s is missing or not a string', (key) => {
    fc.assert(
      fc.property(
        settingsArbitrary,
        fc.constantFrom<unknown>(undefined, 0, true, {}),
        (settings, value) => {
          const json = JSON.stringify({ ...settings, [key]: value })
          expect(() => PhoneSettings.decodeResponse(responseFor(json))).toThrow(key)
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should reject JSON that is not an object', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.array(fc.jsonValue()),
          fc.string(),
          fc.double({ noNaN: true }),
          fc.constant(null)
        ),
        (value) => {
          expect(() => PhoneSettings.decodeResponse(responseFor(JSON.stringify(value)))).toThrow()
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should reject a response that is not JSON', () => {
    expect(() => PhoneSettings.decodeResponse(responseFor('{"patientId":'))).toThrow()
  })
})

describe('decodeStored', () => {
  // PebbleKit JS stores what decodeResponse returns, as JSON, and the sync reads
  // it back.
  it('should decode the settings webviewclosed stored', () => {
    fc.assert(
      fc.property(settingsArbitrary, (settings) => {
        const stored = JSON.stringify(
          PhoneSettings.decodeResponse(responseFor(PebbleSettings.toJson(settings)))
        )
        expect(PhoneSettings.decodeStored(stored)).toEqual(settings)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should reject nothing stored, since the settings page never saved', () => {
    expect(() => PhoneSettings.decodeStored(null)).toThrow('No settings stored')
  })

  it.each(REQUIRED_KEYS)('should reject stored settings whose %s is empty', (key) => {
    fc.assert(
      fc.property(settingsArbitrary, (settings) => {
        expect(() =>
          PhoneSettings.decodeStored(JSON.stringify({ ...settings, [key]: '' }))
        ).toThrow(key)
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

describe('toWatchMessage', () => {
  it('should send the name and birth date, empty for none, and the receipt time in seconds', () => {
    fc.assert(
      fc.property(
        settingsArbitrary,
        fc.nat({ max: 4_102_444_800_000 }),
        (settings, receivedAtMs) => {
          expect(PhoneSettings.toWatchMessage(settings, receivedAtMs)).toEqual({
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
