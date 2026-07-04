/**
 * The {@link Cell} — one permission control's resolved grid view-state, fusing the
 * request clamp (`spec.md §2`) with the wildcard / hierarchy lock (`spec.md §3`). The
 * `granted ⊆ requested` invariant is enforced by *disabling* controls outside the
 * scope request, never by silently dropping a selection. Read within one variant's
 * homogeneous partition (pulled from each {@link Scope.MultiScope} via the recipe's
 * `select`), so no cross-style conversion. A view-model concern with no `scopes-rust`
 * counterpart.
 *
 * Namespace module (`import { Cell } from 'scopes-core'`).
 */

import { Scope } from '../domain/index.ts'
import type * as ScopeRequest from './scope-request.ts'

/** One of the four visual states a permission control (cell or word) can be in. */
type State = 'on' | 'off' | 'locked' | 'disabled'

/**
 * Why a control is locked or disabled — *structured data, not user-facing English*. Pure
 * `scopes-core` stays copy-free (the presentation layer renders the sentence, so the
 * `✶ All record types` label lives in exactly one place). `wildcard`: covered by the
 * same-context `*` record-type row (`spec.md §3`). `required` / `notRequested`: inside /
 * outside the app's request envelope (`spec.md §2`).
 */
type LockReason =
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'required' }
  | { readonly kind: 'notRequested' }

/** A resolved grid cell: its state plus the structured reason for a lock/disable. */
type Cell = {
  readonly state: State
  readonly lockReason: LockReason | null
}

/** The row for a (context, resource) within a variant's partition (exact match). */
const rowFor = <K extends Scope.MultiScope.Kind>(
  owned: readonly Scope.MultiScope.ScopeOf<K>[],
  context: Scope.MultiScope.ContextOf<K>,
  resource: Scope.MultiScope.ResourceOf<K>
): Scope.MultiScope.ScopeOf<K> | undefined =>
  owned.find((s) => s.hasContext(context) && s.hasResource(resource))

/**
 * Resolve one permission control for the grid within `configuration`'s variant. Order:
 * §3 lock (a same-context `*` wildcard row covers it ⇒ locked on) → §2 required (in the
 * `required` subset ⇒ locked on) → §2 clamp (outside the requested envelope *and* not
 * already granted ⇒ disabled) → on/off. Grantedness is computed **first**, so a control the
 * draft actually holds is always shown (`on`/`locked`), never hidden behind a disable —
 * "disabling, never hiding" (`spec.md §2`). `scopeRequest` is `null` for open mode; each
 * partition is pulled from its {@link Scope.MultiScope} via {@link Scope.MultiScope.partition}.
 * The whole cell is generic over the single partition literal `K`: `configuration`, `context`,
 * `resource` and `itemId` are all recovered from it by indexed access
 * ({@link Scope.MultiScope.ContextOf} …), so a variant-generic caller (the grid model) passes
 * one variant's own values with no free `TContext` / `TResource` / `TInteraction` to mismatch.
 */
const forItem = <K extends Scope.MultiScope.Kind>(
  configuration: Scope.MultiScope.ConfigurationFor<K>,
  grant: Scope.MultiScope,
  scopeRequest: ScopeRequest.ScopeRequest | null,
  context: Scope.MultiScope.ContextOf<K>,
  resource: Scope.MultiScope.ResourceOf<K>,
  itemId: Scope.MultiScope.InteractionOf<K>
): Cell => {
  const grantedness = Scope.ScopeConfiguration.scopesGrantInteraction<
    Scope.MultiScope.ContextOf<K>,
    Scope.MultiScope.ResourceOf<K>,
    Scope.MultiScope.InteractionOf<K>,
    K
  >(Scope.MultiScope.partition(grant, configuration.id), context, resource, itemId)

  // §3: covered by a same-context `*` wildcard ⇒ locked on. A held grant is always shown,
  // so this precedes the §2 clamp below.
  if (!grantedness.grantedAtOwnResource) {
    return { state: 'locked', lockReason: { kind: 'wildcard' } }
  }
  // §2 required: a control in the required subset is locked on.
  if (scopeRequest !== null) {
    const required = rowFor(
      Scope.MultiScope.partition(scopeRequest.required, configuration.id),
      context,
      resource
    )
    if (required !== undefined && required.permission.has(itemId)) {
      return { state: 'locked', lockReason: { kind: 'required' } }
    }
  }
  // §2 clamp: a control outside the requested envelope is disabled — unless the draft
  // already grants it, in which case it stays visible (disabling never hides a live grant).
  if (scopeRequest !== null && !grantedness.granted) {
    const requestable = Scope.ScopeConfiguration.scopesGrantInteraction<
      Scope.MultiScope.ContextOf<K>,
      Scope.MultiScope.ResourceOf<K>,
      Scope.MultiScope.InteractionOf<K>,
      K
    >(
      Scope.MultiScope.partition(scopeRequest.requested, configuration.id),
      context,
      resource,
      itemId
    ).granted
    if (!requestable) {
      return { state: 'disabled', lockReason: { kind: 'notRequested' } }
    }
  }
  // on/off: not locked here, so `granted` is exactly "the stored row has this interaction".
  return { state: grantedness.granted ? 'on' : 'off', lockReason: null }
}

export { type State, type LockReason, type Cell, forItem }
