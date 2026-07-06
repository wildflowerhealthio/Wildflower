/**
 * The {@link ScopeRequest} — what an app asked for (request mode), the *envelope* that
 * clamps a grant so `granted ⊆ requested` at all times (`spec.md §2`). Two
 * {@link Scope.MultiScope}s: `requested` (the maximum) and `required` (the mandatory
 * subset that locks on). Absence of a request (`null`) ⇒ open mode (the user builds
 * freely). The per-control grid state this drives is {@link Cell}. A view-model concern
 * with no `scopes-rust` counterpart.
 *
 * Namespace module (`import { ScopeRequest } from 'scopes-core'`).
 */

import { Scope } from '../domain/index.ts'
import type * as GrantDraft from './grant-draft.ts'

/** What an app asked for: the requested envelope, and the mandatory (`required`) subset. */
type ScopeRequest = {
  readonly requested: Scope.MultiScope
  readonly required: Scope.MultiScope
}

/** Whether a flag toggle is disabled (request mode + not requested, `spec.md §2/§7`). */
const flagDisabled = (scopeRequest: ScopeRequest | null, flag: Scope.Known.Name): boolean =>
  scopeRequest !== null && !scopeRequest.requested.known.some((k) => k.name === flag)

/** Whether a flag is required (request mode + in the `required` subset → locked on). */
const flagRequired = (scopeRequest: ScopeRequest | null, flag: Scope.Known.Name): boolean =>
  scopeRequest !== null && scopeRequest.required.known.some((k) => k.name === flag)

/**
 * The invariant `granted ⊆ requested` (`spec.md §2`). True in open mode. Every resource
 * partition must be {@link Scope.ResourceScopeConfiguration.within} the requested envelope,
 * and every granted flag must be requested.
 */
const isWithin = (grant: GrantDraft.GrantDraft, scopeRequest: ScopeRequest | null): boolean => {
  if (scopeRequest === null) return true
  return (
    Scope.MultiScope.within(grant, scopeRequest.requested) &&
    grant.known.every((k) => scopeRequest.requested.known.some((r) => r.name === k.name))
  )
}

export { type ScopeRequest, flagDisabled, flagRequired, isWithin }
