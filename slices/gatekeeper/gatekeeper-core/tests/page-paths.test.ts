import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { Origin } from 'navigation-core'
import { expect, test } from 'vite-plus/test'
import { GatekeeperPaths } from '../src/page-paths.ts'

const ORIGIN = 'https://example.test'
const OriginLive = Origin.layerFromLiteral(ORIGIN)

const runUrl = (effect: Effect.Effect<string, never, Origin>): string =>
  Effect.runSync(Effect.provide(effect, OriginLive))

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

test('oauthPollingUrl prefixes the origin', () => {
  expect(runUrl(GatekeeperPaths.oauthPollingUrl('abc'))).toBe(
    `${ORIGIN}/gatekeeper/oauth-polling/abc`
  )
})

test('deviceEntryUrl prefixes the origin without trailing junk', () => {
  expect(runUrl(GatekeeperPaths.deviceEntryUrl())).toBe(`${ORIGIN}/gatekeeper/devices`)
})

test('deviceEntryUrlWithCode includes the user_code as a URL-encoded query param', () => {
  expect(runUrl(GatekeeperPaths.deviceEntryUrlWithCode('BCDF-GHJK'))).toBe(
    `${ORIGIN}/gatekeeper/devices?user_code=BCDF-GHJK`
  )
})

test('deviceEntryUrlWithCode handles characters outside the RFC 8628 alphabet', () => {
  const url = runUrl(GatekeeperPaths.deviceEntryUrlWithCode('foo bar?'))
  expect(url).toBe(`${ORIGIN}/gatekeeper/devices?user_code=foo+bar%3F`)
  const parsed = new URL(url)
  expect(parsed.searchParams.get('user_code')).toBe('foo bar?')
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
