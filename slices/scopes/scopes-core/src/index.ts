/**
 * `scopes-core` — the canonical, framework-free scope model for the Wildflower
 * scope picker, exported in the Effect-style namespace convention.
 *
 * - `domain/` is a faithful mirror of `scopes-rust`'s `scope/` module tree: the
 *   {@link Scope} kinds ({@link FhirV1} / {@link FhirV2} / {@link Wildflower} /
 *   {@link Known} / {@link Unknown}), the {@link Permission} styles (cruds / read-
 *   write) that carry the editing algebra and display copy, and the {@link Grant}
 *   scope-set, with total (de)serialization.
 * - `view-model/` adds the picker-facing projections the UI renders from
 *   ({@link GrantDraft}, {@link ScopeRequest}). The editing/resolution algebra they
 *   drive (cell toggles, wildcard resolution, flag toggles) lives in `domain/` on
 *   {@link Scope.ScopeConfiguration} and {@link Scope.Known}.
 *
 * Every scope UI component renders from these pure namespaces.
 */

export * from './domain/index.ts'
export * from './view-model/index.ts'
