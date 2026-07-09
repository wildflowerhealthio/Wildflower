/**
 * The {@link ScopeRequest} — what an app asked for (request mode), the *envelope* that
 * clamps a grant so `granted ⊆ available` at all times (`spec.md §2`). Three
 * {@link Scope.MultiScope}s: `requested` (what the requester asked for — seeds the sections
 * and the draft), `required` (the mandatory subset that locks on), and the optional
 * `available` (the *grantable* envelope the clamp is measured against). When `available` is
 * omitted it defaults to `requested` — the **clamped** mode an app consent uses, where the
 * grant may only be narrowed (`granted ⊆ requested`). Passing `available ⊋ requested` is the
 * **expandable** mode the device-authorization flow uses: the approver may add scopes beyond
 * what was requested, up to what the client is allowed. Absence of a request (`null`) ⇒ open
 * mode (the user builds freely). The per-control grid state this drives is {@link Cell}. A
 * view-model concern with no `scopes-rust` counterpart.
 *
 * Namespace module (`import { ScopeRequest } from 'scopes-core'`).
 */

import { Grant, Scope } from '../domain/index.ts'
import type * as GrantDraft from './grant-draft.ts'

/**
 * What an app asked for: the requested envelope, the mandatory (`required`) subset, and the
 * optional `available` grantable envelope. `available` omitted ⇒ clamped mode
 * (`available = requested`); `available ⊋ requested` ⇒ expandable mode.
 */
type ScopeRequest = {
  readonly requested: Scope.MultiScope
  readonly required: Scope.MultiScope
  readonly available?: Scope.MultiScope
}

/**
 * The grantable envelope the `spec.md §2` clamp is measured against — `available` when
 * present, else `requested` (clamped mode). Every clamp/section/flag decision reads through
 * this so clamped mode (the common app-consent case) is `available = requested` by default.
 */
const availableOf = (scopeRequest: ScopeRequest): Scope.MultiScope =>
  scopeRequest.available ?? scopeRequest.requested

/**
 * The all-optional envelope over requested wire scopes: everything requested, nothing
 * required — no control ever locks on, every requested control is prunable (the seed a
 * consent decision edits against). Clamped mode: `available` defaults to `requested`.
 */
const fromRequestedScopes = ({
  optional,
}: {
  readonly optional: readonly string[]
}): ScopeRequest => ({
  requested: Grant.parse(optional),
  required: Grant.make([]),
})

/**
 * The expandable envelope for device-authorization consent: seed the sections/draft from
 * `requested` (what the device asked for), but allow the approver to grant anything within
 * `available` (the client's allowed scopes). Nothing is `required` — every control is
 * prunable, and controls within `available` beyond `requested` are addable.
 */
const expandable = ({
  requested,
  available,
}: {
  readonly requested: readonly string[]
  readonly available: readonly string[]
}): ScopeRequest => ({
  requested: Grant.parse(requested),
  required: Grant.make([]),
  available: Grant.parse(available),
})

/** Whether a flag toggle is disabled (request mode + not grantable, `spec.md §2/§7`). */
const flagDisabled = (scopeRequest: ScopeRequest | null, flag: Scope.Known.Name): boolean =>
  scopeRequest !== null && !availableOf(scopeRequest).known.some((k) => k.name === flag)

/** Whether a flag is required (request mode + in the `required` subset → locked on). */
const flagRequired = (scopeRequest: ScopeRequest | null, flag: Scope.Known.Name): boolean =>
  scopeRequest !== null && scopeRequest.required.known.some((k) => k.name === flag)

/**
 * The invariant `granted ⊆ available` (`spec.md §2`). True in open mode. Every resource
 * partition must be {@link Scope.ResourceScopeConfiguration.within} the grantable envelope,
 * and every granted flag must be grantable. In clamped mode `available = requested`, so this
 * is the familiar `granted ⊆ requested`; in expandable mode it widens to the client's allowed
 * set.
 */
const isWithin = (grant: GrantDraft.GrantDraft, scopeRequest: ScopeRequest | null): boolean => {
  if (scopeRequest === null) return true
  const available = availableOf(scopeRequest)
  return (
    Scope.MultiScope.within(grant, available) &&
    grant.known.every((k) => available.known.some((r) => r.name === k.name))
  )
}

export {
  type ScopeRequest,
  availableOf,
  fromRequestedScopes,
  expandable,
  flagDisabled,
  flagRequired,
  isWithin,
}
