/**
 * The `domain/` layer — a faithful, framework-free mirror of `scopes-rust`'s
 * `scope/` module tree, exported in the Effect-style namespace convention. Each
 * Rust module becomes one namespace:
 *
 * | this folder                | `scopes-rust`                          |
 * | -------------------------- | -------------------------------------- |
 * | {@link Scope}              | `scope/mod.rs`                         |
 * | {@link Grant}              | `scope/grant.rs`                       |
 * | {@link KnownScope}         | `scope/known.rs`                       |
 * | {@link UnknownScope}       | `scope/unknown.rs`                     |
 * | {@link CrudsPermission} / {@link ReadWritePermission} | `scope/resource/permission.rs` (Rust split TBD) |
 * | {@link Fhir}               | `scope/resource/fhir.rs`               |
 * | {@link Wildflower}         | `scope/resource/wildflower.rs`         |
 *
 * Display copy (labels, verbs) lives *on* these classes (`resource.singularLabel()`,
 * `permission.label()`, …). The editing view-model — the patient-bearing
 * {@link GrantDraft}, request clamping, wildcard resolution — lives in the sibling
 * `view-model/` folder and has no `scopes-rust` counterpart.
 */

export * as Scope from './scope/index.ts'
export * as Grant from './grant.ts'
