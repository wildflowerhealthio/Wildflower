import { Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { decodeWebviewResponse } from './pkjs.ts'
import * as ReturnTarget from './return-target.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

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

  it('should decide without URL.canParse, which older phone web views lack', () => {
    // Arrange — iOS 16's WKWebView and Chrome before 120 have no `URL.canParse`
    vi.stubGlobal('URL', urlWithoutCanParse())

    // Act / Assert
    expect(ReturnTarget.isAllowed(ReturnTarget.DEFAULT)).toBe(true)
    expect(ReturnTarget.isAllowed('close')).toBe(false)
  })

  it('should never allow a web address off this machine, where the settings would leak', () => {
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

  it('should decode the default and refuse a non-URL without URL.canParse', () => {
    // Arrange
    vi.stubGlobal('URL', urlWithoutCanParse())

    // Act / Assert
    expect(ReturnTarget.decode(ReturnTarget.DEFAULT)).toStrictEqual(
      Either.right(ReturnTarget.DEFAULT)
    )
    expect(ReturnTarget.decode('close')).toStrictEqual(
      Either.left(new ReturnTarget.ForeignReturnTargetError({ returnTo: 'close' }))
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
  it('should append the URI-encoded JSON to the return target', () => {
    // Arrange
    const target = allowed('pebblejs://close#')

    // Act
    const url = ReturnTarget.handoffUrl(target, '{"name":"Ada Lovelace","token":"a&b#c"}')

    // Assert
    expect(url).toBe(
      'pebblejs://close#' + encodeURIComponent('{"name":"Ada Lovelace","token":"a&b#c"}')
    )
  })

  it('should always hand the watchapp back exactly the JSON it was given', () => {
    fc.assert(
      fc.property(fc.json(), (json) => {
        // Arrange
        const target = allowed(ReturnTarget.DEFAULT)

        // Act
        const url = ReturnTarget.handoffUrl(target, json)

        // Assert — what the watchapp's `webviewclosed` handler parses
        expect(decodeWebviewResponse(url.slice(ReturnTarget.DEFAULT.length))).toStrictEqual(
          JSON.parse(json)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** The platform `URL` class with no static `canParse`, as an older web view ships it. */
const urlWithoutCanParse = (): typeof URL => {
  const PlatformUrl = URL
  class UrlWithoutCanParse extends PlatformUrl {}
  Object.defineProperty(UrlWithoutCanParse, 'canParse', { value: undefined })
  return UrlWithoutCanParse
}

/** `returnTo` decoded as a return target, failing the test when it is refused. */
const allowed = (returnTo: string): ReturnTarget.Type =>
  Either.getOrThrow(ReturnTarget.decode(returnTo))
