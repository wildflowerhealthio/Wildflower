/**
 * The {@link Cell} — one permission control's resolved grid view-state, fusing the
 * request clamp (`spec.md §2`) with the wildcard / hierarchy lock (`spec.md §3`). The
 * `granted ⊆ requested` invariant is enforced by *disabling* controls outside the
 * scope request, never by silently dropping a selection. Read within one variant's
 * homogeneous partition (pulled from each {@link Scope.MultiScope} via
 * {@link Scope.MultiScope.partition}), so no cross-style conversion. A view-model
 * concern with no `scopes-rust` counterpart.
 *
 * Namespace module (`import { Cell } from 'scopes-core'`).
 */

import { Scope } from '../domain/index.ts'
import * as ScopeRequest from './scope-request.ts'

/** One of the four visual states a permission control (cell or word) can be in. */
type State = 'on' | 'off' | 'locked' | 'disabled'

/**
 * Why a control is locked or disabled — *structured data, not user-facing English*. Pure
 * `scopes-core` stays copy-free (the presentation layer renders the sentence, so the
 * wildcard-row label lives in exactly one place). `wildcard`: covered by the
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

/**
 * A per-section cell resolver: folds the grant / required / requested partitions **once**
 * for a (variant, context) into per-resource interaction sets, then resolves any
 * `(resource, itemId)` cell in O(1) — the shared engine behind {@link forItem} (one cell)
 * and {@link Rows.build} (a whole grid section), so a row's five cells don't re-scan the
 * partitions five times each.
 *
 * The folds reproduce {@link Scope.ResourceScopeConfiguration.scopesGrantInteraction} exactly:
 * a scope contributes to a cell iff its context covers the section's and its resource is
 * the cell's own (`key`) or the `*` wildcard bucket; the wildcard bucket covering a
 * non-wildcard row is precisely the §3 wildcard lock. The `required` fold is
 * exact-context and unions duplicate rows for one resource (consistent with
 * {@link Scope.ResourceScopeConfiguration.toggleItem}'s merge).
 */
const resolver = <K extends Scope.MultiScope.Kind>(
  configuration: Scope.MultiScope.ResourceScopeConfigurationFor<K>,
  grant: Scope.MultiScope,
  scopeRequest: ScopeRequest.ScopeRequest | null,
  context: Scope.MultiScope.ContextOf<K>
): ((
  resource: Scope.MultiScope.ResourceOf<K>,
  itemId: Scope.MultiScope.InteractionOf<K>
) => Cell) => {
  /** Per-resource interaction sets over every scope whose context covers the section's. */
  const coveringFold = (
    partition: readonly Scope.MultiScope.ScopeOf<K>[]
  ): ReadonlyMap<string, ReadonlySet<string>> => {
    const map = new Map<string, Set<string>>()
    for (const scope of partition) {
      if (!scope.context.covers(context)) continue
      const key = scope.resource.serialize()
      const set = map.get(key) ?? new Set<string>()
      for (const interaction of scope.permission.toArray()) set.add(interaction)
      map.set(key, set)
    }
    return map
  }

  const grantCovering = coveringFold(Scope.MultiScope.partition(grant, configuration.id))
  // §2 clamp is measured against the *grantable* envelope: `requested` in clamped mode,
  // the (wider) client-allowed `available` in expandable mode. `availableOf` defaults to
  // `requested`, so clamped consent is unchanged.
  const availableCovering =
    scopeRequest === null
      ? null
      : coveringFold(
          Scope.MultiScope.partition(ScopeRequest.availableOf(scopeRequest), configuration.id)
        )

  /** Per-resource interaction sets of the `required` subset — exact context, duplicate rows unioned. */
  const requiredExact = new Map<string, Set<string>>()
  if (scopeRequest !== null) {
    for (const scope of Scope.MultiScope.partition(scopeRequest.required, configuration.id)) {
      if (!scope.hasContext(context)) continue
      const key = scope.resource.serialize()
      const set = requiredExact.get(key) ?? new Set<string>()
      for (const interaction of scope.permission.toArray()) set.add(interaction)
      requiredExact.set(key, set)
    }
  }

  return (resource, itemId) => {
    const key = resource.serialize()
    // §3: covered by a `*` wildcard row (which is the only different-resource cover) ⇒
    // locked on. A held grant is always shown, so this precedes the §2 clamp below.
    if (key !== '*' && (grantCovering.get('*')?.has(itemId) ?? false)) {
      return { state: 'locked', lockReason: { kind: 'wildcard' } }
    }
    // §2 required: a control in the required subset is locked on.
    if (requiredExact.get(key)?.has(itemId) ?? false) {
      return { state: 'locked', lockReason: { kind: 'required' } }
    }
    // Not wildcard-locked here, so `granted` is exactly "the stored row has this interaction".
    const granted = grantCovering.get(key)?.has(itemId) ?? false
    // §2 clamp: a control outside the grantable envelope is disabled — unless the draft
    // already grants it, in which case it stays visible (disabling never hides a live grant).
    if (availableCovering !== null && !granted) {
      const grantable =
        (availableCovering.get(key)?.has(itemId) ?? false) ||
        (key !== '*' && (availableCovering.get('*')?.has(itemId) ?? false))
      if (!grantable) {
        return { state: 'disabled', lockReason: { kind: 'notRequested' } }
      }
    }
    return { state: granted ? 'on' : 'off', lockReason: null }
  }
}

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
 * A thin delegate over {@link resolver} — resolving many cells of one section? Build the
 * resolver (or {@link Rows.build}) once instead.
 */
const forItem = <K extends Scope.MultiScope.Kind>(
  configuration: Scope.MultiScope.ResourceScopeConfigurationFor<K>,
  grant: Scope.MultiScope,
  scopeRequest: ScopeRequest.ScopeRequest | null,
  context: Scope.MultiScope.ContextOf<K>,
  resource: Scope.MultiScope.ResourceOf<K>,
  itemId: Scope.MultiScope.InteractionOf<K>
): Cell => resolver(configuration, grant, scopeRequest, context)(resource, itemId)

export { type State, type LockReason, type Cell, resolver, forItem }
