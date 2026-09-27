import { Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type * as PebbleSettings from './pebble-settings.ts'
import * as ReturnTarget from './return-target.ts'

describe('isAllowed', () => {
  it("should allow the Pebble app's own close URL", () => {
    expect(ReturnTarget.isAllowed('pebblejs://close#')).toBe(true)
  })

  it("should allow a local emulator's configuration server", () => {
    expect(ReturnTarget.isAllowed('http://localhost:61234/close?')).toBe(true)
    expect(ReturnTarget.isAllowed('http://127.0.0.1:61234/close?')).toBe(true)
    expect(ReturnTarget.isAllowed('http://[::1]:61234/close?')).toBe(true)
  })

  it('should refuse something that is not a URL', () => {
    expect(ReturnTarget.isAllowed('close')).toBe(false)
  })

  it('should never allow a web address off this machine, where the token would leak', () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
        expect(ReturnTarget.isAllowed(url)).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('decode', () => {
  it('should decode an allowed return target', () => {
    expect(ReturnTarget.decode(ReturnTarget.DEFAULT)).toStrictEqual(
      Either.right(ReturnTarget.DEFAULT)
    )
  })

  it('should name the refused return_to in its error', () => {
    // Act
    const target = ReturnTarget.decode('https://collector.example/#')

    // Assert
    expect(target).toStrictEqual(
      Either.left(
        new ReturnTarget.ForeignReturnTargetError({ returnTo: 'https://collector.example/#' })
      )
    )
  })
})

describe('handoffUrl', () => {
  it('should append the URI-encoded settings JSON to the return target', () => {
    // Arrange
    const target = allowed('pebblejs://close#')

    // Act
    const url = ReturnTarget.handoffUrl(target, {
      patientId: 'ada',
      patientName: 'Ada Lovelace',
      patientBirthDate: '1815-12-10',
      accessToken: 'watch-token',
      fhirBaseUrl: 'https://fhir.example/r4',
    })

    // Assert
    expect(url).toBe(
      'pebblejs://close#' +
        encodeURIComponent(
          '{"patientId":"ada","patientName":"Ada Lovelace","patientBirthDate":"1815-12-10",' +
            '"accessToken":"watch-token","fhirBaseUrl":"https://fhir.example/r4"}'
        )
    )
  })

  it('should always hand the watch back exactly the settings it was given', () => {
    fc.assert(
      fc.property(settingsArb, (settings) => {
        // Arrange
        const target = allowed(ReturnTarget.DEFAULT)

        // Act
        const url = ReturnTarget.handoffUrl(target, settings)

        // Assert — what the watch's `webviewclosed` handler parses
        const payload = decodeURIComponent(url.slice(ReturnTarget.DEFAULT.length))
        expect(JSON.parse(payload)).toStrictEqual(settings)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const settingsArb: fc.Arbitrary<PebbleSettings.Type> = fc.record({
  patientId: fc.string({ minLength: 1 }),
  patientName: fc.option(fc.string(), { nil: null }),
  patientBirthDate: fc.option(fc.string(), { nil: null }),
  accessToken: fc.string({ minLength: 1 }),
  fhirBaseUrl: fc.webUrl(),
})

/** `returnTo` decoded as a return target, failing the test when it is refused. */
const allowed = (returnTo: string): ReturnTarget.Type =>
  Either.getOrThrow(ReturnTarget.decode(returnTo))
