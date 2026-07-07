/**
 * The `view-model/` layer — the picker-facing projections over `domain/`, exported in
 * the Effect-style namespace convention:
 *
 * - {@link GrantDraft} — the editable `{patient, …partitions}` picker state + wire serialization
 * - {@link ScopeRequest} — the request-mode envelope + `granted ⊆ requested` clamp (§2)
 * - {@link Cell} — one permission control's resolved grid view-state (§2 clamp + §3 lock)
 * - {@link Rows} — the request-aware row list for a grid section (row + wildcard-injection policy)
 * - {@link Sections} — the grid sections a request derives (one per kind/context, ordered resources)
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
export * as Rows from './rows.ts'
export * as ResourceSection from './resource-section.ts'
