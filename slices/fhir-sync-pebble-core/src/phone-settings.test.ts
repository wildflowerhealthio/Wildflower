import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import { utf8Bytes } from '@wildflowerhealthio/kitchen-sink'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as PebbleSettings from './pebble-settings.ts'
import * as PhoneSettings from './phone-settings.ts'

const settingsArbitrary = Arbitrary.make(PebbleSettings.Schema)

const SETTINGS: PhoneSettings.Settings = {
  patientId: 'ada-lovelace',
  patientName: 'Ada Lovelace',
  patientBirthDate: '1815-12-10',
  accessToken: 'token',
  fhirBaseUrl: 'https://fhir.example/r4',
}

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
  // PebbleKit JS stores what decodeResponse returns with when it arrived, and
  // the sync and every later settings message read it back.
  it('should decode the settings webviewclosed stored and when they arrived', () => {
    fc.assert(
      fc.property(
        settingsArbitrary,
        fc.nat({ max: 4_102_444_800_000 }),
        (settings, receivedAtMs) => {
          const stored = PhoneSettings.toStored(
            PhoneSettings.decodeResponse(responseFor(PebbleSettings.toJson(settings))),
            receivedAtMs
          )
          expect(PhoneSettings.decodeStored(stored)).toEqual({ settings, receivedAtMs })
        }
      ),
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
          PhoneSettings.decodeStored(PhoneSettings.toStored({ ...settings, [key]: '' }, 0))
        ).toThrow(key)
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it.each([
    ['no receivedAtMs', JSON.stringify({ settings: SETTINGS })],
    ['a fractional receivedAtMs', JSON.stringify({ settings: SETTINGS, receivedAtMs: 0.5 })],
    ['bare settings', JSON.stringify(SETTINGS)],
    ['not an object', '42'],
  ])('should reject stored settings with %s', (_, stored) => {
    expect(() => PhoneSettings.decodeStored(stored)).toThrow()
  })
})

describe('toWatchMessage', () => {
  it('should send the name and birth date, empty for none, and the receipt time in seconds', () => {
    fc.assert(
      fc.property(
        settingsArbitrary,
        fc.nat({ max: 4_102_444_800_000 }),
        (settings, receivedAtMs) => {
          fc.pre(
            byteLength(settings.patientName) <= 63 && byteLength(settings.patientBirthDate) <= 10
          )
          expect(PhoneSettings.toWatchMessage(settings, receivedAtMs)).toEqual({
            PatientName: settings.patientName ?? '',
            PatientBirthDate: settings.patientBirthDate ?? '',
            AuthTime: Math.floor(receivedAtMs / 1000),
            ConnectionId: PhoneSettings.connectionId(settings),
          })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should cut the name to 63 bytes and the birth date to 10, between code points', () => {
    fc.assert(
      fc.property(
        settingsArbitrary,
        longTextArbitrary,
        longTextArbitrary,
        (settings, name, birthDate) => {
          // Act
          const message = PhoneSettings.toWatchMessage(
            { ...settings, patientName: name, patientBirthDate: birthDate },
            0
          )

          // Assert: what is kept is a prefix that encodes as the text's own
          // leading bytes, so no character was split.
          for (const [sent, text, maxBytes] of [
            [message.PatientName, name, 63],
            [message.PatientBirthDate, birthDate, 10],
          ] as const) {
            const sentBytes = utf8Bytes(sent)
            expect(sentBytes.length).toBeLessThanOrEqual(maxBytes)
            expect(text.startsWith(sent)).toBe(true)
            expect(utf8Bytes(text).slice(0, sentBytes.length)).toEqual(sentBytes)
          }
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it.each([
    ['ASCII', 'A'.repeat(70), 'A'.repeat(63)],
    // 21 three-byte characters are exactly 63 bytes.
    ['three-byte characters', '日'.repeat(30), '日'.repeat(21)],
    // 15 four-byte characters are 60 bytes; a 16th would make 64.
    ['surrogate pairs', '😀'.repeat(20), '😀'.repeat(15)],
    ['a surrogate pair straddling the limit', `${'a'.repeat(61)}😀`, 'a'.repeat(61)],
  ])('should cut a name of %s', (_, patientName, sent) => {
    const settings = { ...SETTINGS, patientName }
    expect(PhoneSettings.toWatchMessage(settings, 0).PatientName).toBe(sent)
  })
})

describe('connectionId', () => {
  it('should name the patient on the server, the same for the same pair', () => {
    fc.assert(
      fc.property(settingsArbitrary, settingsArbitrary, (first, second) => {
        const sameConnection =
          first.fhirBaseUrl === second.fhirBaseUrl && first.patientId === second.patientId
        expect(PhoneSettings.connectionId(first) === PhoneSettings.connectionId(second)).toBe(
          sameConnection
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should stay the same across a sign-in again to the same patient', () => {
    fc.assert(
      fc.property(settingsArbitrary, fc.string({ minLength: 1 }), (settings, accessToken) => {
        expect(PhoneSettings.connectionId({ ...settings, accessToken })).toBe(
          PhoneSettings.connectionId(settings)
        )
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should differ for the same patient id on another server', () => {
    const other = { ...SETTINGS, fhirBaseUrl: 'https://other.example/fhir' }
    expect(PhoneSettings.connectionId(other)).not.toBe(PhoneSettings.connectionId(SETTINGS))
  })

  it("should be fhir-r4's local id for the patient on the server", () => {
    expect(PhoneSettings.connectionId(SETTINGS)).toBe(
      localResourceId(SETTINGS.fhirBaseUrl, 'Patient', SETTINGS.patientId)
    )
  })
})

// Helpers

/** `text`'s length in UTF-8 bytes, 0 for none. */
const byteLength = (text: string | null): number => (text === null ? 0 : utf8Bytes(text).length)

/** Text often past the watch's limits, with multi-byte characters and surrogate pairs. */
const longTextArbitrary = fc
  .array(fc.constantFrom('a', 'é', '日', '😀', ' '), { maxLength: 80 })
  .map((characters) => characters.join(''))
