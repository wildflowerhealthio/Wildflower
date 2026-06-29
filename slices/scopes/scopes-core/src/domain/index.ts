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
 * | {@link AccessRights}       | `scope/resource/access_rights.rs`      |
 * | {@link Fhir}               | `scope/resource/fhir.rs`               |
 * | {@link Wildflower}         | `scope/resource/wildflower.rs`         |
 *
 * The editing view-model (the subject-bearing {@link GrantDraft}, ScopeContexts,
 * request clamping, labels, verbs) lives in the sibling `view-model/` and
 * `language/` folders — none of it has a `scopes-rust` counterpart.
 */

export * as Scope from './scope.ts'
export * as Grant from './grant.ts'
export * as KnownScope from './known.ts'
export * as UnknownScope from './unknown.ts'
export { AccessRights, Fhir, Wildflower } from './resource/index.ts'
