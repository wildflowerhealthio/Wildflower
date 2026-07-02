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

/** A resolved grid cell: its state plus the tooltip explaining a lock/disable. */
type Cell = {
  readonly state: State
  readonly lockReason: string | null
}

/** The row for a (context, resource) within a variant's partition (exact match). */
const rowFor = <
  TContext extends Scope.Contexts.Context,
  TResource extends Scope.ResourceType.Base,
  TInteraction extends string,
>(
  partition: readonly Scope.ResourceScope.Base<TContext, TResource, TInteraction>[],
  context: TContext,
  resource: TResource
): Scope.ResourceScope.Base<TContext, TResource, TInteraction> | undefined =>
  partition.find((s) => s.hasContext(context) && s.hasResource(resource))

/**
 * Resolve one permission control for the grid within `configuration`'s variant. Order:
 * §2 clamp (outside the requested envelope ⇒ disabled) → §3 lock (a strictly-broader
 * scope covers it ⇒ locked) → §2 required (in the `required` subset ⇒ locked) → on/off.
 * `scopeRequest` is `null` for open mode; each partition is pulled from its
 * {@link Scope.MultiScope} via `configuration.select`. Its `context` / `resource` /
 * `itemId` are the config's own `TContext` / `TResource` / `TInteraction` — same
 * convention as {@link Scope.ScopeConfiguration.toggleItem}, so a variant-generic caller
 * (the grid model) can pass them without an indexed-access cast.
 */
const forItem = <
  TContext extends Scope.Contexts.Context,
  TResource extends Scope.ResourceType.Base,
  TInteraction extends string,
  TId extends Scope.ResourceScope.Any['kind'],
>(
  configuration: Scope.ScopeConfiguration<TContext, TResource, TInteraction, TId>,
  grant: Scope.MultiScope,
  scopeRequest: ScopeRequest.ScopeRequest | null,
  context: TContext,
  resource: TResource,
  itemId: TInteraction
): Cell => {
  // §2 clamp: a control outside the requested envelope is disabled.
  if (scopeRequest !== null) {
    const requested = rowFor(configuration.select(scopeRequest.requested), context, resource)
    if (requested === undefined || !requested.permission.has(itemId)) {
      return { state: 'disabled', lockReason: 'Not requested by the app' }
    }
  }
  // §3: covered by a strictly-broader scope ⇒ locked on.
  const owned = configuration.select(grant)
  const grantedness = Scope.ScopeConfiguration.scopesGrantInteraction<
    TContext,
    TResource,
    TInteraction
  >(owned, context, resource, itemId)
  if (!grantedness.grantedAtOwnResource) {
    return { state: 'locked', lockReason: 'Granted by ✶ All record types' }
  }
  // §2 required: a control in the required subset is locked on.
  if (scopeRequest !== null) {
    const required = rowFor(configuration.select(scopeRequest.required), context, resource)
    if (required !== undefined && required.permission.has(itemId)) {
      return { state: 'locked', lockReason: 'Required by the app' }
    }
  }
  // on/off: not locked here, so `granted` is exactly "the stored row has this interaction".
  return { state: grantedness.granted ? 'on' : 'off', lockReason: null }
}

export { type State, type Cell, forItem }
