/**
 * Wildcard ↔ specific-row resolution and the grant mutations (`spec.md §3`).
 * `effective = wildcard ∪ specific`, with wildcard-covered cells locked. The
 * edits are pure and immutable, returning a new `Scope[]`. A view-model concern
 * (interactive editing) with no `scopes-rust` counterpart.
 *
 * Namespace module (`import { Resolve } from 'scopes-core'`).
 */

import type { KnownScope } from '../domain/index.ts'
import { AccessRights, Scope } from '../domain/index.ts'
import * as Bucket from './bucket.ts'
import * as Grant from './grant.ts'
import * as Words from './words.ts'

const matchesRow = (scope: Scope.Scope, bucket: Bucket.Bucket, name: string): boolean =>
  Scope.isResource(scope) && Bucket.contains(bucket, scope) && Scope.resourceName(scope) === name

/** Remove a (bucket, resource) row entirely (the consent "Remove" affordance). */
export const removeResource = (
  scopes: readonly Scope.Scope[],
  bucket: Bucket.Bucket,
  name: string
): Scope.Scope[] => scopes.filter((s) => !matchesRow(s, bucket, name))

const upsertResource = (
  scopes: readonly Scope.Scope[],
  bucket: Bucket.Bucket,
  name: string,
  next: Scope.Scope
): Scope.Scope[] => {
  const exists = scopes.some((s) => matchesRow(s, bucket, name))
  return exists ? scopes.map((s) => (matchesRow(s, bucket, name) ? next : s)) : [...scopes, next]
}

/** The resolved state of one (bucket, resource, action) cell (`spec.md §3`). */
export type EffectiveCell = {
  /** Granted = covered by the wildcard, or held by the specific row. */
  readonly granted: boolean
  /** Locked = covered by the wildcard (not independently removable on a row). */
  readonly locked: boolean
  readonly source: 'wildcard' | 'specific' | 'none'
}

/** Resolve a single CRUDS cell against the bucket's wildcard + specific rows. */
export const effectiveCell = (
  scopes: readonly Scope.Scope[],
  bucket: Bucket.Bucket,
  name: string,
  action: AccessRights.Action
): EffectiveCell => {
  // The wildcard row's OWN cells aren't "covered by a wildcard" — they are the
  // wildcard, and must stay editable (untick Read on `*` to remove it
  // everywhere, §3). Only specific rows are locked by it.
  const isWildcardRow = name === '*'
  const wildcard = Grant.findWildcard(scopes, bucket)
  const coveredByWildcard =
    !isWildcardRow &&
    wildcard !== undefined &&
    AccessRights.lettersOf(wildcard.access).includes(action)
  const specific = Grant.findResource(scopes, bucket, name)
  const specificHas =
    specific !== undefined && AccessRights.lettersOf(specific.access).includes(action)
  return {
    granted: coveredByWildcard || specificHas,
    locked: coveredByWildcard,
    source: coveredByWildcard ? 'wildcard' : specificHas ? 'specific' : 'none',
  }
}

/**
 * Toggle one CRUDS cell on a v2 (letters-form) row, returning NEW scopes. A
 * no-op when the wildcard already covers the action (the cell is locked, §3).
 * Specific rows that empty out are dropped; the wildcard row is kept.
 */
export const toggleCell = (
  scopes: readonly Scope.Scope[],
  bucket: Bucket.Bucket,
  name: string,
  action: AccessRights.Action
): Scope.Scope[] => {
  const isWildcardRow = name === '*'
  if (!isWildcardRow) {
    const wildcard = Grant.findWildcard(scopes, bucket)
    if (wildcard !== undefined && AccessRights.lettersOf(wildcard.access).includes(action)) {
      return [...scopes] // locked by the wildcard — unchanged
    }
  }
  const existing = Grant.findResource(scopes, bucket, name)
  if (existing !== undefined && existing.access.kind !== 'letters') {
    return [...scopes] // word-form rows are edited via the v1 multiselect, not cells
  }
  const current = existing === undefined ? [] : [...AccessRights.lettersOf(existing.access)]
  const index = current.indexOf(action)
  const nextLetters =
    index >= 0
      ? current.filter((a) => a !== action)
      : AccessRights.sortActions([...current, action])
  if (nextLetters.length === 0 && !isWildcardRow) return removeResource(scopes, bucket, name)
  const nextScope = Bucket.makeResource(bucket, name, AccessRights.letters(nextLetters))
  return nextScope === null ? [...scopes] : upsertResource(scopes, bucket, name, nextScope)
}

/**
 * Toggle one v1 word component (Read or Write) on a (bucket, resource) row.
 * Read + Write ⇒ `*`; one ⇒ that word; neither ⇒ the row is dropped.
 */
export const toggleWordComponent = (
  scopes: readonly Scope.Scope[],
  bucket: Bucket.Bucket,
  name: string,
  component: Words.Component
): Scope.Scope[] => {
  const current = Grant.findResource(scopes, bucket, name)?.access ?? null
  const parts = { ...Words.of(current) }
  parts[component] = !parts[component]
  const access = Words.toAccess(parts)
  if (access === null) return removeResource(scopes, bucket, name)
  const nextScope = Bucket.makeResource(bucket, name, access)
  return nextScope === null ? [...scopes] : upsertResource(scopes, bucket, name, nextScope)
}

/** Set a flag (Known) scope on or off, returning NEW scopes. */
export const setFlag = (
  scopes: readonly Scope.Scope[],
  flag: KnownScope.KnownScope,
  on: boolean
): Scope.Scope[] => {
  const without = scopes.filter((s) => !(s.kind === 'known' && s.scope === flag))
  return on ? [...without, { kind: 'known', scope: flag }] : without
}

/** Toggle a flag (Known) scope. */
export const toggleFlag = (
  scopes: readonly Scope.Scope[],
  flag: KnownScope.KnownScope
): Scope.Scope[] => setFlag(scopes, flag, !Grant.hasFlag(scopes, flag))
