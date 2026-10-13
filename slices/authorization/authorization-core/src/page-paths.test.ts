import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { expect, test } from 'vite-plus/test'
import { AuthorizationServerPaths } from './page-paths.ts'

test('deviceEntryUrlOn moves the server’s device-entry page onto the given copy, query intact', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(
        'https://wildflowerhealthio.github.io/staging/pr-7/launcher/',
        'http://localhost:5200/',
        'https://wildflowerhealth.io/launcher/'
      ),
      fc.webUrl({ withQueryParameters: true }),
      (servedRoot, verificationUri) => {
        // Act
        const moved = new URL(
          AuthorizationServerPaths.deviceEntryUrlOn(servedRoot, verificationUri)
        )

        // Assert — the copy's own device-entry page, carrying exactly the
        // query the server built.
        expect(`${moved.origin}${moved.pathname}`).toBe(`${servedRoot}authorization/devices`)
        expect(moved.search).toBe(new URL(verificationUri).search)
      }
    ),
    { numRuns: numRunsFor({ base: 100 }) }
  )
})

test('deviceEntryUrlOn refuses a verification URI that is not absolute', () => {
  expect(() =>
    AuthorizationServerPaths.deviceEntryUrlOn('https://x.test/app/', '/authorization/devices')
  ).toThrow(TypeError)
})

test('oauthConsentPath percent-encodes the request id', () => {
  expect(AuthorizationServerPaths.oauthConsentPath('abc')).toBe('/authorization/oauth-consent/abc')
  expect(AuthorizationServerPaths.oauthConsentPath('?bad')).toBe('/authorization/oauth-consent/%3Fbad')
})

test('deviceConsentPath percent-encodes the user code', () => {
  expect(AuthorizationServerPaths.deviceConsentPath('BCDF-GHJK')).toBe(
    '/authorization/devices/BCDF-GHJK'
  )
})

test('deviceConsentPath percent-encodes characters outside the RFC 8628 alphabet', () => {
  // Regression guard for future user-code character-class expansion.
  const inputs = ['a/b', 'a?b', 'a#b', 'a&b', 'a b', 'a%b', 'aÆb']
  for (const input of inputs) {
    const path = AuthorizationServerPaths.deviceConsentPath(input)
    expect(path.startsWith('/authorization/devices/')).toBe(true)
    const segment = path.replace('/authorization/devices/', '')
    expect(decodeURIComponent(segment)).toBe(input)
    expect(segment).not.toContain('/')
    expect(segment).not.toContain('?')
    expect(segment).not.toContain('#')
  }
})

test('property: any user code produces a valid path that round-trips through decodeURIComponent', () => {
  fc.assert(
    fc.property(fc.string(), (userCode) => {
      const path = AuthorizationServerPaths.deviceConsentPath(userCode)
      const segment = path.slice('/authorization/devices/'.length)
      expect(decodeURIComponent(segment)).toBe(userCode)
    }),
    { numRuns: numRunsFor({ base: 100 }) }
  )
})
