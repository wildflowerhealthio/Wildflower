/**
 * Wildcard ↔ specific-row resolution and the grant mutations (`spec.md §3`).
 * `effective = wildcard ∪ specific`, with wildcard-covered cells locked. These
 * are the pure, immutable edits both projections call.
 */

import {
  accessFromComponents,
  accessLetters,
  lettersAccess,
  sortActions,
  wordComponentsOf,
  type WordComponent,
} from './access.ts'
import type { Action, Context, ScopePermission } from './model.ts'

const sameRow = (p: ScopePermission, context: Context, resource: string): boolean =>
  p.context === context && p.resource === resource

const wildcardOf = (
  permissions: readonly ScopePermission[],
  context: Context
): ScopePermission | undefined => permissions.find((p) => sameRow(p, context, '*'))

/** The resolved state of one (context, resource, action) cell (`spec.md §3`). */
export interface EffectiveCell {
  /** Granted = covered by the wildcard, or held by the specific row. */
  readonly granted: boolean
  /** Locked = covered by the wildcard (not independently removable on a row). */
  readonly locked: boolean
  readonly source: 'wildcard' | 'specific' | 'none'
}

/** Resolve a single CRUDS cell against the wildcard + specific rows. */
export const effectiveCell = (
  permissions: readonly ScopePermission[],
  context: Context,
  resource: string,
  action: Action
): EffectiveCell => {
  // The wildcard row's OWN cells aren't "covered by a wildcard" — they are the
  // wildcard, and must stay editable (untick Read on `*` to remove it
  // everywhere, §3). Only specific rows are locked by it.
  const isWildcardRow = resource === '*'
  const wildcard = wildcardOf(permissions, context)
  const coveredByWildcard =
    !isWildcardRow && wildcard !== undefined && accessLetters(wildcard.access).includes(action)
  const specific = permissions.find((p) => sameRow(p, context, resource))
  const specificHas = specific !== undefined && accessLetters(specific.access).includes(action)
  return {
    granted: coveredByWildcard || specificHas,
    locked: coveredByWildcard,
    source: coveredByWildcard ? 'wildcard' : specificHas ? 'specific' : 'none',
  }
}

const withoutEmpty = (permissions: readonly ScopePermission[]): ScopePermission[] =>
  permissions.filter((p) => p.resource === '*' || accessLetters(p.access).length > 0)

/**
 * Toggle one CRUDS cell on a v2 (letters-form) row, returning a NEW permissions
 * array. A no-op when the wildcard already covers the action (the cell is
 * locked, `spec.md §3`). Works for both the wildcard row (`resource === '*'`)
 * and specific rows. Specific rows that empty out are dropped; the wildcard row
 * is kept even when empty so its column stays visible.
 */
export const toggleCell = (
  permissions: readonly ScopePermission[],
  context: Context,
  resource: string,
  action: Action
): ScopePermission[] => {
  if (resource !== '*') {
    const wildcard = wildcardOf(permissions, context)
    if (wildcard !== undefined && accessLetters(wildcard.access).includes(action)) {
      return [...permissions] // locked by the wildcard — unchanged
    }
  }
  const existing = permissions.find((p) => sameRow(p, context, resource))
  if (existing !== undefined && existing.access.form === 'word') {
    return [...permissions] // word-form rows are edited via the v1 level picker, not cells
  }
  const current = existing === undefined ? [] : [...accessLetters(existing.access)]
  const index = current.indexOf(action)
  const nextLetters =
    index >= 0 ? current.filter((a) => a !== action) : sortActions([...current, action])
  const nextRow: ScopePermission = { context, resource, access: lettersAccess(nextLetters) }
  const replaced =
    existing === undefined
      ? [...permissions, nextRow]
      : permissions.map((p) => (sameRow(p, context, resource) ? nextRow : p))
  return withoutEmpty(replaced)
}

/**
 * Toggle one v1 word component (Read or Write) on a (context, resource) row,
 * returning a NEW permissions array. Read + Write ⇒ `*`; one ⇒ that word;
 * neither ⇒ the row is dropped. This is the v1 multiselect's mutation, the word
 * counterpart to {@link toggleCell}.
 */
export const toggleWordComponent = (
  permissions: readonly ScopePermission[],
  context: Context,
  resource: string,
  component: WordComponent
): ScopePermission[] => {
  const current = permissions.find((p) => sameRow(p, context, resource))?.access ?? null
  const parts = { ...wordComponentsOf(current) }
  parts[component] = !parts[component]
  const access = accessFromComponents(parts)
  if (access === null) return permissions.filter((p) => !sameRow(p, context, resource))
  const nextRow: ScopePermission = { context, resource, access }
  const exists = permissions.some((p) => sameRow(p, context, resource))
  return exists
    ? permissions.map((p) => (sameRow(p, context, resource) ? nextRow : p))
    : [...permissions, nextRow]
}

/** Remove a (context, resource) row entirely (the consent "Remove" affordance). */
export const removePermission = (
  permissions: readonly ScopePermission[],
  context: Context,
  resource: string
): ScopePermission[] => permissions.filter((p) => !sameRow(p, context, resource))
