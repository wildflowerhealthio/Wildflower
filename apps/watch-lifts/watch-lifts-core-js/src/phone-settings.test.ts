import { Arbitrary } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as LiftSettings from './lift-settings.ts'
import * as Lifts from './lifts.ts'
import * as PhoneSettings from './phone-settings.ts'

const settingsArbitrary = Arbitrary.make(LiftSettings.Schema)

/** The `webviewclosed` response for `json`, as the configuration page hands it back. */
const responseFor = (json: string): string => encodeURIComponent(json)

/** A value that is not a weight the settings accept. */
const notAWeightArbitrary = fc.oneof(
  fc.integer({ min: Lifts.MAX_WEIGHT + 1 }),
  fc.integer({ max: -1 }),
  fc.double({ noNaN: true, noInteger: true }),
  fc.constantFrom<unknown>('60', null, true, {}, [])
)

describe('decodeResponse', () => {
  // The wire contract: what the configuration page's toJson writes is what
  // the watchapp decodes, weight for weight.
  it('should decode whatever the configuration page saves', () => {
    fc.assert(
      fc.property(settingsArbitrary, (settings) => {
        expect(PhoneSettings.decodeResponse(responseFor(LiftSettings.toJson(settings)))).toEqual(
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

  it('should reject any weight that is not a whole number from 0 to 999', () => {
    fc.assert(
      fc.property(
        settingsArbitrary,
        fc.nat({ max: Lifts.PEOPLE.length - 1 }),
        fc.nat({ max: Lifts.EXERCISES.length - 1 }),
        notAWeightArbitrary,
        (settings, person, exercise, value) => {
          const weights = settings.weights.map((row, p) =>
            row.map((weight, e) => (p === person && e === exercise ? value : weight))
          )
          expect(() =>
            PhoneSettings.decodeResponse(responseFor(JSON.stringify({ weights })))
          ).toThrow(`weights[${person}][${exercise}]`)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should reject a row too short or too long', () => {
    fc.assert(
      fc.property(
        settingsArbitrary,
        fc.nat({ max: Lifts.PEOPLE.length - 1 }),
        fc.array(fc.nat({ max: Lifts.MAX_WEIGHT }), { maxLength: 8 }),
        (settings, person, row) => {
          fc.pre(row.length !== Lifts.EXERCISES.length)
          const weights = settings.weights.map((original, p) => (p === person ? row : original))
          expect(() =>
            PhoneSettings.decodeResponse(responseFor(JSON.stringify({ weights })))
          ).toThrow(`weights[${person}]`)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it.each([
    ['no weights', {}],
    ['a row too few', { weights: [[60, 50, 50, 50, 85]] }],
    ['a row too many', { weights: [...Lifts.DEFAULT_WEIGHTS, [1, 2, 3, 4, 5]] }],
    ['weights that are not rows', { weights: 'heavy' }],
  ])('should reject settings with %s', (_, settings) => {
    expect(() => PhoneSettings.decodeResponse(responseFor(JSON.stringify(settings)))).toThrow(
      'weights'
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
    expect(() => PhoneSettings.decodeResponse(responseFor('{"weights":'))).toThrow()
  })
})

describe('decodeStored', () => {
  it('should decode the settings webviewclosed stored', () => {
    fc.assert(
      fc.property(settingsArbitrary, (settings) => {
        const stored = PhoneSettings.toStored(
          PhoneSettings.decodeResponse(responseFor(LiftSettings.toJson(settings)))
        )
        expect(PhoneSettings.decodeStored(stored)).toEqual(settings)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read nothing stored as no settings, since the settings page never saved', () => {
    expect(PhoneSettings.decodeStored(null)).toBeNull()
  })

  it('should reject stored settings of another shape', () => {
    expect(() => PhoneSettings.decodeStored(JSON.stringify(Lifts.DEFAULT_WEIGHTS))).toThrow()
  })
})

describe('configurationUrl', () => {
  it('should carry the settings as the JSON the page decodes, in its weights parameter', () => {
    fc.assert(
      fc.property(settingsArbitrary, (settings) => {
        // Act
        const url = new URL(PhoneSettings.configurationUrl('https://example.test/lifts/', settings))

        // Assert
        expect(url.origin + url.pathname).toBe('https://example.test/lifts/')
        const json = url.searchParams.get(PhoneSettings.PARAM) ?? ''
        expect(json).toBe(LiftSettings.toJson(settings))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should open the page with the defaults', () => {
    expect(PhoneSettings.configurationUrl('https://example.test/', PhoneSettings.DEFAULT)).toBe(
      'https://example.test/?weights=' +
        encodeURIComponent('{"weights":[[60,50,50,50,85],[65,55,55,45,85]]}')
    )
  })
})

describe('toWatchMessage', () => {
  it('should lay the weights out person-major, two bytes each, low byte first', () => {
    // Arrange: 300 is 0x012c, so its bytes are 44 then 1.
    const settings: PhoneSettings.Settings = {
      weights: [
        [300, 1, 2, 3, 4],
        [5, 6, 7, 8, 999],
      ],
    }

    // Act
    const message = PhoneSettings.toWatchMessage(settings)

    // Assert
    expect(message).toEqual({
      Weights: [44, 1, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8, 0, 231, 3],
    })
  })

  it('should send WEIGHTS_BYTES bytes that read back as the weights', () => {
    fc.assert(
      fc.property(settingsArbitrary, (settings) => {
        // Act
        const bytes = PhoneSettings.toWatchMessage(settings).Weights

        // Assert
        expect(bytes).toHaveLength(PhoneSettings.WEIGHTS_BYTES)
        const view = new DataView(Uint8Array.from(bytes).buffer)
        const weights = Lifts.PEOPLE.map((_name, person) =>
          Lifts.EXERCISES.map((_title, exercise) =>
            view.getUint16(2 * (person * Lifts.EXERCISES.length + exercise), true)
          )
        )
        expect(weights).toEqual(settings.weights)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
