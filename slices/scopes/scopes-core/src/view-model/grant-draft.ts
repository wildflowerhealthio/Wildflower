/**
 * The {@link GrantDraft} — the editable picker state, the single source of truth a
 * picker edits (`spec.md §5`): a {@link Scope.MultiScope} (the domain {@link Grant}
 * partitions) plus `patient` (a UI concern). {@link serialize} / {@link serializeAll}
 * project it to the wire scope list, with the per-partition `spec.md §3` dedupe delegated
 * to {@link Scope.MultiScope.serialize}. None of it has a `scopes-rust` counterpart.
 *
 * Namespace module (`import { GrantDraft } from 'scopes-core'`).
 */

import { Scope, type Grant } from '../domain/index.ts'

/**
 * A patient plus a set of scopes. `patient` is a patient id, or `null` for an
 * all-patients (`system/`) grant. Every projection renders from this one object.
 */
type GrantDraft = {
  readonly patient: string | null
} & Grant.Grant

/**
 * The draft's resource scopes as sorted, de-duplicated wire strings — {@link Scope.MultiScope.serialize}
 * dedupes each partition against itself (`spec.md §3`), then they're combined and sorted
 * (never deduped across styles or contexts).
 */
const serialize = (grant: GrantDraft): string[] =>
  [...new Set(Scope.MultiScope.serialize(grant))].toSorted()

/** The full scope list a draft emits — resource scopes (deduped) + flags + preserved unknowns. */
const serializeAll = (grant: GrantDraft): string[] => [
  ...serialize(grant),
  ...grant.known.map((k) => k.serialize()).toSorted(),
  ...grant.unknown.map((u) => u.serialize()).toSorted(),
]

export { type GrantDraft, serialize, serializeAll }
