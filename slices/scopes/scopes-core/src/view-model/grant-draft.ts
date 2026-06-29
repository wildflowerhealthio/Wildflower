/**
 * The {@link GrantDraft} — the editable picker state, the single source of truth a
 * picker edits. A subject plus a `Vec<Scope>`. The pure scope-set model is the
 * domain {@link Grant}; this view-model adds `subject` (which patient — a UI
 * concern) and the ScopeContext-aware projections (find a row, the wildcard
 * dedupe of `spec.md §3`) that have no `scopes-rust` counterpart.
 *
 * Namespace module (`import { GrantDraft } from 'scopes-core'`).
 */

import type { Fhir } from '../domain/index.ts'
import { AccessRights, Grant, Scope } from '../domain/index.ts'
import * as ScopeContext from './scope-context.ts'

/**
 * A subject plus a set of scopes (a `Vec<Scope>`). `subject` is a patient id, or
 * {@link ALL_PATIENTS} for a `system/` grant. Every projection (the consent
 * sentences, the resource grid, the flag toggles) renders from this one object
 * (`spec.md §5`).
 */
export type GrantDraft = {
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

/** Find the resource scope for a (scope context, resource name), if granted. */
export const findResource = (
  scopes: readonly Scope.Scope[],
  scopeContext: ScopeContext.ScopeContext,
  name: string
): Scope.Resource | undefined =>
  Grant.resourceScopes(scopes).find(
    (s) => ScopeContext.contains(scopeContext, s) && Scope.resourceName(s) === name
  )

/** The same scope context `*` wildcard resource scope, if any. */
export const findWildcard = (
  scopes: readonly Scope.Scope[],
  scopeContext: ScopeContext.ScopeContext
): Scope.Resource | undefined => findResource(scopes, scopeContext, '*')

/**
 * Serialize a draft's resource scopes with wildcard dedupe (`spec.md §3`): a
 * specific scope omits actions already covered by its same scope context wildcard, and
 * is dropped entirely when the wildcard covers it. Returns a sorted, deduped
 * array of resource scope strings.
 */
export const serialize = (grant: GrantDraft): string[] => {
  const out: string[] = []
  for (const scope of Grant.resourceScopes(grant.scopes)) {
    const name = Scope.resourceName(scope)
    if (name === '*') {
      const s = Scope.scopeSerialize(scope)
      if (s !== '') out.push(s)
      continue
    }
    const wildcard = findWildcard(grant.scopes, ScopeContext.of(scope))
    if (wildcard === undefined) {
      const s = Scope.scopeSerialize(scope)
      if (s !== '') out.push(s)
      continue
    }
    const covered = new Set(AccessRights.lettersOf(wildcard.access))
    const own = AccessRights.lettersOf(scope.access)
    if (own.every((a) => covered.has(a))) continue // fully covered by the wildcard
    if (scope.access.kind === 'letters') {
      const remaining = own.filter((a) => !covered.has(a))
      const s = Scope.scopeSerialize({ ...scope, access: AccessRights.letters(remaining) })
      if (s !== '') out.push(s)
    } else {
      // A v1 word only partially covered can't be cleanly subtracted; emit it
      // whole (redundant emission is harmless, just less tidy).
      const s = Scope.scopeSerialize(scope)
      if (s !== '') out.push(s)
    }
  }
  return [...new Set(out)].toSorted()
}

/** The full scope list a draft emits — resource scopes (deduped) + flags + preserved unknowns. */
export const serializeAll = (grant: GrantDraft): string[] => [
  ...serialize(grant),
  ...Grant.knownScopes(grant.scopes).toSorted(),
  ...Grant.unknownScopes(grant.scopes).toSorted(),
]
