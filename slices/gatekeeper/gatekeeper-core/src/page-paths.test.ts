import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { expect, test } from 'vite-plus/test'
import { GatekeeperPaths } from './page-paths.ts'

test('oauthPollingPath percent-encodes the request id', () => {
  expect(GatekeeperPaths.oauthPollingPath('abc')).toBe('/gatekeeper/oauth-polling/abc')
  expect(GatekeeperPaths.oauthPollingPath('a/b')).toBe('/gatekeeper/oauth-polling/a%2Fb')
})

test('oauthConsentPath percent-encodes the request id', () => {
  expect(GatekeeperPaths.oauthConsentPath('abc')).toBe('/gatekeeper/oauth-consent/abc')
  expect(GatekeeperPaths.oauthConsentPath('?bad')).toBe('/gatekeeper/oauth-consent/%3Fbad')
})

test('deviceConsentPath percent-encodes the user code', () => {
  expect(GatekeeperPaths.deviceConsentPath('BCDF-GHJK')).toBe('/gatekeeper/devices/BCDF-GHJK')
})

test('deviceConsentPath percent-encodes characters outside the RFC 8628 alphabet', () => {
  // Regression guard for future user-code character-class expansion.
  const inputs = ['a/b', 'a?b', 'a#b', 'a&b', 'a b', 'a%b', 'aÆb']
  for (const input of inputs) {
    const path = GatekeeperPaths.deviceConsentPath(input)
    expect(path.startsWith('/gatekeeper/devices/')).toBe(true)
    const segment = path.replace('/gatekeeper/devices/', '')
    expect(decodeURIComponent(segment)).toBe(input)
    expect(segment).not.toContain('/')
    expect(segment).not.toContain('?')
    expect(segment).not.toContain('#')
  }
})

test('property: any user code produces a valid path that round-trips through decodeURIComponent', () => {
  fc.assert(
    fc.property(fc.string(), (userCode) => {
      const path = GatekeeperPaths.deviceConsentPath(userCode)
      const segment = path.slice('/gatekeeper/devices/'.length)
      expect(decodeURIComponent(segment)).toBe(userCode)
    }),
    { numRuns: numRunsFor({ base: 100 }) }
  )
})
