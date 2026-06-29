/**
 * The `language/` layer — the terminology of the scope picker: the constants and
 * word-assembly that turn the domain model into the words a person reads. None
 * has a `scopes-rust` counterpart; it sits on top of `domain/` (and addresses
 * rows via the view-model's ScopeContext):
 *
 * - {@link Labels} — resource + flag display copy (the nouns, `spec.md §7`)
 * - {@link Verbs} — the granted access written as a sentence (the verbs, `spec.md §1`)
 * - {@link Words} — the SMART v1 Read/Write vocabulary the multiselect speaks
 */

export * as Labels from './labels.ts'
export * as Verbs from './verbs.ts'
export * as Words from './words.ts'
