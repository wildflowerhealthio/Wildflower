import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  buildDeviceLoginTarget,
  buildStepUpTarget,
  DEVICE_LOGIN_ROUTE,
  parseDeviceLoginSearch,
  parseRequestScopes,
  serializeRequestScopes,
} from './device-login-route.ts'

/**
 * The device-login target builders are the single source both the 401 redirect
 * and the 403 step-up navigate through, so the params they emit have to survive
 * the trip through a real URL and come back as the same scope list. These pin the
 * encoding end-to-end: `buildStepUpTarget` → query string → `parseDeviceLoginSearch`
 * → `parseRequestScopes`.
 */

/** Serialize a target's `search` the way a router would put it on the wire. */
const toQueryString = (search: Record<string, string | undefined>): string => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined) params.set(key, value)
  }
  return params.toString()
}

/**
 * A scope-shaped token: no whitespace, so it survives the space-separated
 * encoding intact. Built from constants rather than `fc.stringMatching` (which
 * is correct but slow enough to dominate a property's runtime).
 */
const scopeArb = fc
  .tuple(
    fc.constantFrom('wildflower', 'system', 'patient', 'user'),
    fc.constantFrom('Grant', 'Client', 'RefreshToken', '*'),
    fc.constantFrom('r', 'rs', 'd', 'cruds')
  )
  .map(([context, resource, permission]) => `${context}/${resource}.${permission}`)

describe('buildDeviceLoginTarget', () => {
  test('targets the device-login route and carries returnTo alone', () => {
    // The 401 path is unchanged by step-up: no `requestScopes` key appears, so a
    // plain sign-in still lands on the preset seed rather than an empty request.
    const target = buildDeviceLoginTarget('/settings/databases')
    expect(target.to).toBe(DEVICE_LOGIN_ROUTE)
    expect(target.search.returnTo).toBe('/settings/databases')
    expect(target.search.requestScopes).toBeUndefined()
  })
})

describe('buildStepUpTarget', () => {
  test('pre-fills the missing scopes alongside the denial location', () => {
    const target = buildStepUpTarget(['wildflower/Grant.d', 'wildflower/Grant.r'], '/settings')
    expect(target.to).toBe(DEVICE_LOGIN_ROUTE)
    expect(target.search.returnTo).toBe('/settings')
    expect(target.search.requestScopes).toBe('wildflower/Grant.d wildflower/Grant.r')
  })

  test('de-duplicates repeated scopes', () => {
    // A 403 may name the same scope twice (two gated calls on one page); the
    // request should ask for it once.
    const target = buildStepUpTarget(['wildflower/Grant.d', 'wildflower/Grant.d'])
    expect(target.search.requestScopes).toBe('wildflower/Grant.d')
  })

  test('omits the param entirely when nothing was named', () => {
    // The undeclared-403 shape. Collapsing to the plain target is what lets the
    // screen fall back to its preset seed instead of showing an empty request.
    const target = buildStepUpTarget([], '/settings')
    expect(target.search.requestScopes).toBeUndefined()
    expect(target).toEqual(buildDeviceLoginTarget('/settings'))
  })
})

describe('requestScopes encoding', () => {
  for (const [raw, expected] of [
    [undefined, []],
    [null, []],
    ['', []],
    ['   ', []],
    ['wildflower/Grant.d', ['wildflower/Grant.d']],
    ['a  b\tc', ['a', 'b', 'c']],
  ] as const) {
    test(`parses ${JSON.stringify(raw)} into ${JSON.stringify(expected)}`, () => {
      expect(parseRequestScopes(raw)).toEqual(expected)
    })
  }

  test('round-trips any scope list through a real query string', () => {
    // The end-to-end invariant the step-up flow depends on: whatever the 403
    // named comes back out of the URL as the same list (de-duplicated, in order).
    fc.assert(
      fc.property(fc.array(scopeArb, { maxLength: 8 }), fc.string(), (scopes, returnTo) => {
        const target = buildStepUpTarget(scopes, returnTo)
        const parsed = parseDeviceLoginSearch(toQueryString({ ...target.search }))
        expect(parseRequestScopes(parsed.requestScopes)).toEqual([...new Set(scopes)])
        // `returnTo` rides the same trip untouched — sanitization happens at use.
        expect(parsed.returnTo ?? '').toBe(returnTo)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('serialization is total: no input can smuggle a separator through', () => {
    // Arbitrary strings, including ones containing whitespace: serializing
    // re-splits them, so parsing the result never yields a token with a space in
    // it and never yields an empty token.
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 8 }), (raw) => {
        const parsed = parseRequestScopes(serializeRequestScopes(raw))
        for (const scope of parsed) {
          expect(scope).not.toMatch(/\s/)
          expect(scope).not.toBe('')
        }
        // Idempotent under the encoding — a second pass changes nothing.
        expect(serializeRequestScopes([...parsed])).toBe(serializeRequestScopes(raw))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('parseDeviceLoginSearch', () => {
  test('omits absent params rather than reporting them as empty', () => {
    // `returnTo: ''` and "no returnTo" are different: the former would sanitize
    // to the default landing path, the latter must stay absent so a caller can
    // tell them apart.
    expect(parseDeviceLoginSearch('')).toEqual({})
    expect(parseDeviceLoginSearch('returnTo=')).toEqual({ returnTo: '' })
  })
})
