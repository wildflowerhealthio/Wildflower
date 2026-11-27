import { Effect, Either } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { checkTimeZone, isKnownTimeZone } from './index.ts'
import { numRunsFor } from './test/index.ts'

const runtimeZones = Intl.supportedValuesOf('timeZone')

describe('isKnownTimeZone', () => {
  it('recognizes every zone the runtime lists', () => {
    fc.assert(
      fc.property(fc.constantFrom(...runtimeZones), (zone) => isKnownTimeZone(zone)),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects the half-typed prefixes of a zone and names that are not zones', () => {
    expect(['America/Tor', 'America/', 'Mars/Olympus', ''].map(isKnownTimeZone)).toEqual([
      false,
      false,
      false,
      false,
    ])
  })
})

describe('checkTimeZone', () => {
  it('succeeds with a zone the runtime lists, as given', () => {
    fc.assert(
      fc.property(fc.constantFrom(...runtimeZones), (zone) => {
        expect(Effect.runSync(Effect.either(checkTimeZone(zone)))).toEqual(Either.right(zone))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('fails with a parse error naming a name that is not a zone', () => {
    const checked = Effect.runSync(Effect.either(checkTimeZone('America/Tor')))

    expect(Either.isLeft(checked)).toBe(true)
    if (Either.isLeft(checked)) {
      expect(checked.left._tag).toBe('ParseError')
      expect(checked.left.message).toContain('"America/Tor" is not an IANA time zone name')
    }
  })
})
