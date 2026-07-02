/**
 * The `view-model/` layer — the picker-facing projections over `domain/`, exported in
 * the Effect-style namespace convention:
 *
 * - {@link GrantDraft} — the editable `{patient, …partitions}` picker state + wire serialization
 * - {@link ScopeRequest} — the request-mode envelope + `granted ⊆ requested` clamp (§2)
 * - {@link Cell} — one permission control's resolved grid view-state (§2 clamp + §3 lock)
 *
 * The editing/resolution/serialization algebra itself lives in the domain and is shared
 * by all three: wildcard resolution, cell toggles, and §3 serialize dedupe on
 * {@link Scope.ScopeConfiguration} (`scopesGrantInteraction` / `toggleItem` / `serialize`),
 * flag toggles on {@link Scope.Known} (`setFlag` / `toggleFlag`, §7). A row addresses the
 * domain via a {@link Scope.Contexts.Context} + its {@link Scope.ResourceType}; construction
 * goes through the row's {@link Scope.ScopeConfiguration}. Coverage, locking, and dedupe are
 * computed with the domain's `isSupersetOf` (strict context, wildcard-aware resource) / `has`
 * — always same-style, never converted.
 */

export * as GrantDraft from './grant-draft.ts'
export * as ScopeRequest from './scope-request.ts'
export * as Cell from './cell.ts'
