/**
 * `scopes-core` — the canonical, framework-free scope model for the Wildflower
 * scope picker, exported in the Effect-style namespace convention.
 *
 * - `domain/` is a faithful mirror of `scopes-rust`'s `scope/` module tree: the
 *   {@link Scope} union and its {@link Fhir} / {@link Wildflower} /
 *   {@link KnownScope} / {@link UnknownScope} kinds, the {@link AccessRights}
 *   permission model, the {@link Grant} scope-set, and total (de)serialization.
 * - `view-model/` adds the editing model the UI renders from ({@link ScopeContext},
 *   {@link GrantDraft}, {@link ScopeRequest}, {@link Resolve}) — none of it has a
 *   `scopes-rust` counterpart.
 * - `language/` holds the terminology ({@link Labels}, {@link Verbs},
 *   {@link Words}) — the constants and word-assembly the picker reads from.
 * - `behaviour/` names the cross-cutting contracts the domain namespaces conform
 *   to ({@link ScopeSerializer}, {@link ScopeParser}).
 *
 * Every scope UI component renders from these pure namespaces.
 */

export * from './behaviour/index.ts'
export * from './domain/index.ts'
export * from './language/index.ts'
export * from './view-model/index.ts'
