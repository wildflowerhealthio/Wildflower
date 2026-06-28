/**
 * The `view-model/` layer — the editing model the scope-picker UI renders from,
 * exported in the Effect-style namespace convention. None of this has a
 * `scopes-rust` counterpart: `scopes-rust` is the pure scope *grammar*, while
 * these namespaces add the *editing* model on top of `domain/`:
 *
 * - {@link Bucket} — addresses a grid/consent row (a FHIR context, or Wildflower)
 * - {@link Grant} — the `{subject, scopes}` aggregate + scope-list accessors + wire serialization
 * - {@link Envelope} — the request-mode clamp (§2) and grid cell view-state
 * - {@link Resolve} — wildcard resolution (§3) and the grant mutations
 * - {@link Words} — the SMART v1 Read/Write multiselect components
 * - {@link Labels} — resource + flag display copy
 * - {@link Verbs} — the access summary written as a sentence
 */

export * as Bucket from './bucket.ts'
export * as Grant from './grant.ts'
export * as Envelope from './envelope.ts'
export * as Resolve from './resolve.ts'
export * as Words from './words.ts'
export * as Labels from './labels.ts'
export * as Verbs from './verbs.ts'
