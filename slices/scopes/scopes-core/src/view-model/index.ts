/**
 * The `view-model/` layer — the editing model the scope-picker UI renders from,
 * exported in the Effect-style namespace convention. None of this has a
 * `scopes-rust` counterpart: `scopes-rust` is the pure scope *grammar*, while
 * these namespaces add the *editing* model on top of `domain/`:
 *
 * - {@link ScopeContext} — addresses a grid/consent row (a FHIR context, or Wildflower)
 * - {@link GrantDraft} — the editable `{subject, scopes}` picker state + wire serialization
 * - {@link ScopeRequest} — the request-mode clamp (§2) and grid cell view-state
 * - {@link Resolve} — wildcard resolution (§3) and the grant mutations
 *
 * The terminology layer (labels, verbs, words) lives in the sibling `language/`
 * folder.
 */

export * as ScopeContext from './scope-context.ts'
export * as GrantDraft from './grant-draft.ts'
export * as ScopeRequest from './scope-request.ts'
export * as Resolve from './resolve.ts'
