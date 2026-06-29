/**
 * The {@link Grant} grant — the single source of truth a picker edits. A subject
 * plus a `Vec<Scope>`; `scopes-rust` has no Grant type (a grant is conceptually
 * just a set of scopes), and `subject` (which patient) is purely a UI concern,
 * so this lives in the view-model, not `domain/`.
 *
 * Also home to the scope-list accessors and grant→wire serialization that
 * operate over a whole `Scope[]` (Rust keeps these crate-level, in
 * `lib.rs`/`smart.rs`, not in the per-scope module).
 *
 * Namespace module (`import { Grant } from 'scopes-core'`).
 */

import type { Fhir, KnownScope } from '../domain/index.ts'
import { AccessRights, Scope } from '../domain/index.ts'
import * as Bucket from './bucket.ts'

/**
 * A subject plus a set of scopes (a `Vec<Scope>`). `subject` is a patient id, or
 * {@link ALL_PATIENTS} for a `system/` grant. Every projection (the consent
 * sentences, the resource grid, the flag toggles) renders from this one object
 * (`spec.md §5`).
 */
export type Grant = {
  readonly subject: string
  readonly scopes: readonly Scope.Scope[]
}

/** The subject sentinel for an all-patients (`system/`) grant. */
export const ALL_PATIENTS = 'all'

/**
 * Subject contexts offered when the user builds a grant from scratch (open /
 * device mode). `user/` is excluded — it is only ever *shown* when an app
 * requests it. `system` (all patients) is the elevated choice.
 */
export const OFFERABLE_CONTEXTS: readonly Fhir.ContextLevel[] = ['patient', 'system']

/** The resource scopes (FHIR + Wildflower) in a scope list. */
export const resourceScopes = (scopes: readonly Scope.Scope[]): Scope.Resource[] =>
  scopes.filter(Scope.isResource)

/** The flag (Known) scopes in a scope list. */
export const flagScopes = (scopes: readonly Scope.Scope[]): KnownScope.KnownScope[] => {
  const out: KnownScope.KnownScope[] = []
  for (const s of scopes) if (s.kind === 'known') out.push(s.scope)
  return out
}

/** The unrecognized scopes, preserved verbatim. */
export const unknownScopes = (scopes: readonly Scope.Scope[]): string[] => {
  const out: string[] = []
  for (const s of scopes) if (s.kind === 'unknown') out.push(s.raw)
  return out
}

/** Find the resource scope for a (bucket, resource name), if granted. */
export const findResource = (
  scopes: readonly Scope.Scope[],
  bucket: Bucket.Bucket,
  name: string
): Scope.Resource | undefined =>
  resourceScopes(scopes).find((s) => Bucket.contains(bucket, s) && Scope.resourceName(s) === name)

/** The same-bucket `*` wildcard resource scope, if any. */
export const findWildcard = (
  scopes: readonly Scope.Scope[],
  bucket: Bucket.Bucket
): Scope.Resource | undefined => findResource(scopes, bucket, '*')

/** Whether the grant holds a given flag scope. */
export const hasFlag = (scopes: readonly Scope.Scope[], flag: KnownScope.KnownScope): boolean =>
  scopes.some((s) => s.kind === 'known' && s.scope === flag)

/**
 * Serialize a grant's resource scopes with wildcard dedupe (`spec.md §3`): a
 * specific scope omits actions already covered by its same-bucket wildcard, and
 * is dropped entirely when the wildcard covers it. Returns a sorted, deduped
 * array of resource scope strings.
 */
export const serialize = (grant: Grant): string[] => {
  const out: string[] = []
  for (const scope of resourceScopes(grant.scopes)) {
    const name = Scope.resourceName(scope)
    if (name === '*') {
      const s = Scope.serialize(scope)
      if (s !== '') out.push(s)
      continue
    }
    const wildcard = findWildcard(grant.scopes, Bucket.of(scope))
    if (wildcard === undefined) {
      const s = Scope.serialize(scope)
      if (s !== '') out.push(s)
      continue
    }
    const covered = new Set(AccessRights.lettersOf(wildcard.access))
    const own = AccessRights.lettersOf(scope.access)
    if (own.every((a) => covered.has(a))) continue // fully covered by the wildcard
    if (scope.access.kind === 'letters') {
      const remaining = own.filter((a) => !covered.has(a))
      const s = Scope.serialize({ ...scope, access: AccessRights.letters(remaining) })
      if (s !== '') out.push(s)
    } else {
      // A v1 word only partially covered can't be cleanly subtracted; emit it
      // whole (redundant emission is harmless, just less tidy).
      const s = Scope.serialize(scope)
      if (s !== '') out.push(s)
    }
  }
  return [...new Set(out)].toSorted()
}

/** The full scope list a grant emits — resource scopes (deduped) + flags + preserved unknowns. */
export const serializeAll = (grant: Grant): string[] => [
  ...serialize(grant),
  ...flagScopes(grant.scopes).toSorted(),
  ...unknownScopes(grant.scopes).toSorted(),
]
