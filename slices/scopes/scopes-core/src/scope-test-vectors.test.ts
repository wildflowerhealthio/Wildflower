/**
 * Cross-language contract tests over `slices/scopes/scope-test-vectors.json`,
 * the fixture shared with `scopes-rust`'s `tests/vectors.rs`. Both suites
 * consume the same file, so a semantic change on one side of the TS/Rust
 * scope-grammar mirror fails the other side's build instead of drifting
 * silently.
 */
import { describe, expect, test } from 'vite-plus/test'

import vectors from '../../scope-test-vectors.json'
import { Grant, Scope } from './index.ts'

/** The (single) populated partition of a one-scope grant — the fixture's `kind`. */
const kindOf = (grant: Grant.Grant): string => {
  const kinds = (['fhirV1', 'fhirV2', 'wildflower', 'known', 'unknown'] as const).filter(
    (kind) => grant[kind].length > 0
  )
  expect(kinds).toHaveLength(1)
  return kinds[0] ?? 'none'
}

/**
 * Whether `allowed` covers `requested` — the TS counterpart of Rust's
 * `allowed_scope_covers`, going through the same {@link Scope.MultiScope.within}
 * path production uses ({@link ScopeRequest.isWithin}), plus the known/unknown
 * exact-membership rule.
 */
const covers = (allowed: string, requested: string): boolean => {
  const allowedGrant = Grant.parse([allowed])
  const requestedGrant = Grant.parse([requested])
  return (
    Scope.MultiScope.within(requestedGrant, allowedGrant) &&
    requestedGrant.known.every((k) => allowedGrant.known.some((a) => a.name === k.name)) &&
    requestedGrant.unknown.every((u) =>
      allowedGrant.unknown.some((a) => a.serialize() === u.serialize())
    )
  )
}

describe('scope-test-vectors.json (shared with scopes-rust)', () => {
  test('parse vectors agree on kind and rendering', () => {
    for (const { scope, kind, rendered } of vectors.parse) {
      const grant = Grant.parse([scope])
      expect(kindOf(grant), `kind of ${scope}`).toBe(kind)
      expect(Grant.render(grant), `rendering of ${scope}`).toEqual([rendered])
    }
  })

  test('coverage vectors agree with MultiScope.within', () => {
    for (const c of vectors.coverage) {
      expect(covers(c.allowed, c.requested), `${c.allowed} covers ${c.requested}`).toBe(c.covers)
    }
  })
})
