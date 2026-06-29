/**
 * Wildcard ↔ specific-row resolution and the grant mutations (`spec.md §3`).
 * `effective = wildcard ∪ specific`, with wildcard-covered cells locked. The
 * edits are pure and immutable, returning a new `Scope[]`. A view-model concern
 * (interactive editing) with no `scopes-rust` counterpart.
 *
 * Namespace module (`import { Resolve } from 'scopes-core'`).
 */

import type { KnownScope } from '../domain/index.ts'
import { AccessRights, Grant, Scope } from '../domain/index.ts'
import * as Words from '../language/words.ts'
import * as GrantDraft from './grant-draft.ts'
import * as ScopeContext from './scope-context.ts'

const matchesRow = (
  scope: Scope.Scope,
  scopeContext: ScopeContext.ScopeContext,
  name: string
): boolean =>
  Scope.isResource(scope) &&
  ScopeContext.contains(scopeContext, scope) &&
  Scope.resourceName(scope) === name

/** Remove a (scope context, resource) row entirely (the consent "Remove" affordance). */
const removeResource = (
  scopes: readonly Scope.Scope[],
  scopeContext: ScopeContext.ScopeContext,
  name: string
): Scope.Scope[] => scopes.filter((s) => !matchesRow(s, scopeContext, name))

const upsertResource = (
  scopes: readonly Scope.Scope[],
  scopeContext: ScopeContext.ScopeContext,
  name: string,
  next: Scope.Scope
): Scope.Scope[] => {
  const exists = scopes.some((s) => matchesRow(s, scopeContext, name))
  return exists
    ? scopes.map((s) => (matchesRow(s, scopeContext, name) ? next : s))
    : [...scopes, next]
}

/** The resolved state of one (scope context, resource, action) cell (`spec.md §3`). */
type EffectiveCell = {
  /** Granted = covered by the wildcard, or held by the specific row. */
  readonly granted: boolean
  /** Locked = covered by the wildcard (not independently removable on a row). */
  readonly locked: boolean
  readonly source: 'wildcard' | 'specific' | 'none'
}

/** Where a resolved cell's grant comes from — the wildcard wins over a specific row. */
const cellSource = (coveredByWildcard: boolean, specificHas: boolean): EffectiveCell['source'] => {
  if (coveredByWildcard) return 'wildcard'
  if (specificHas) return 'specific'
  return 'none'
}

/** Resolve a single CRUDS cell against the scope context's wildcard + specific rows. */
const effectiveCell = (
  scopes: readonly Scope.Scope[],
  scopeContext: ScopeContext.ScopeContext,
  name: string,
  action: AccessRights.Action
): EffectiveCell => {
  // The wildcard row's OWN cells aren't "covered by a wildcard" — they are the
  // wildcard, and must stay editable (untick Read on `*` to remove it
  // everywhere, §3). Only specific rows are locked by it.
  const isWildcardRow = name === '*'
  const wildcard = GrantDraft.findWildcard(scopes, scopeContext)
  const coveredByWildcard =
    !isWildcardRow &&
    wildcard !== undefined &&
    AccessRights.lettersOf(wildcard.access).includes(action)
  const specific = GrantDraft.findResource(scopes, scopeContext, name)
  const specificHas =
    specific !== undefined && AccessRights.lettersOf(specific.access).includes(action)
  return {
    granted: coveredByWildcard || specificHas,
    locked: coveredByWildcard,
    source: cellSource(coveredByWildcard, specificHas),
  }
}

/**
 * Toggle one CRUDS cell on a v2 (letters-form) row, returning NEW scopes. A
 * no-op when the wildcard already covers the action (the cell is locked, §3).
 * Specific rows that empty out are dropped; the wildcard row is kept.
 */
const toggleCell = (
  scopes: readonly Scope.Scope[],
  scopeContext: ScopeContext.ScopeContext,
  name: string,
  action: AccessRights.Action
): Scope.Scope[] => {
  const isWildcardRow = name === '*'
  if (!isWildcardRow) {
    const wildcard = GrantDraft.findWildcard(scopes, scopeContext)
    if (wildcard !== undefined && AccessRights.lettersOf(wildcard.access).includes(action)) {
      return [...scopes] // locked by the wildcard — unchanged
    }
  }
  const existing = GrantDraft.findResource(scopes, scopeContext, name)
  if (existing !== undefined && existing.access.kind !== 'letters') {
    return [...scopes] // word-form rows are edited via the v1 multiselect, not cells
  }
  const current = existing === undefined ? [] : [...AccessRights.lettersOf(existing.access)]
  const index = current.indexOf(action)
  const nextLetters =
    index >= 0
      ? current.filter((a) => a !== action)
      : AccessRights.sortActions([...current, action])
  if (nextLetters.length === 0 && !isWildcardRow) return removeResource(scopes, scopeContext, name)
  const nextScope = ScopeContext.makeResource(scopeContext, name, AccessRights.letters(nextLetters))
  return nextScope === null ? [...scopes] : upsertResource(scopes, scopeContext, name, nextScope)
}

/**
 * Toggle one v1 word component (Read or Write) on a (scope context, resource) row.
 * Read + Write ⇒ `*`; one ⇒ that word; neither ⇒ the row is dropped.
 */
const toggleWordComponent = (
  scopes: readonly Scope.Scope[],
  scopeContext: ScopeContext.ScopeContext,
  name: string,
  component: Words.Component
): Scope.Scope[] => {
  const current = GrantDraft.findResource(scopes, scopeContext, name)?.access ?? null
  const parts = { ...Words.of(current) }
  parts[component] = !parts[component]
  const access = Words.toAccess(parts)
  if (access === null) return removeResource(scopes, scopeContext, name)
  const nextScope = ScopeContext.makeResource(scopeContext, name, access)
  return nextScope === null ? [...scopes] : upsertResource(scopes, scopeContext, name, nextScope)
}

/** Set a flag (Known) scope on or off, returning NEW scopes. */
const setFlag = (
  scopes: readonly Scope.Scope[],
  flag: KnownScope.KnownScope,
  on: boolean
): Scope.Scope[] => {
  const without = scopes.filter((s) => !(s.kind === 'known' && s.scope === flag))
  return on ? [...without, { kind: 'known', scope: flag }] : without
}

/** Toggle a flag (Known) scope. */
const toggleFlag = (scopes: readonly Scope.Scope[], flag: KnownScope.KnownScope): Scope.Scope[] =>
  setFlag(scopes, flag, !Grant.hasKnown(scopes, flag))

export {
  removeResource,
  type EffectiveCell,
  effectiveCell,
  toggleCell,
  toggleWordComponent,
  setFlag,
  toggleFlag,
}
