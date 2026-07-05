/**
 * The {@link GrantDraft} — the editable picker state, the single source of truth a
 * picker edits (`spec.md §5`): a {@link Scope.MultiScope} (the domain {@link Grant}
 * partitions) plus `patient` (a UI concern). {@link serialize} / {@link serializeAll}
 * project it to the wire scope list, with the per-partition `spec.md §3` dedupe delegated
 * to {@link Scope.MultiScope.serialize}. None of it has a `scopes-rust` counterpart.
 *
 * Namespace module (`import { GrantDraft } from 'scopes-core'`).
 */

import { Scope, Grant } from '../domain/index.ts'
import type * as ScopeRequest from './scope-request.ts'

/**
 * A patient plus a set of scopes. `patient` is a patient id, or `null` for an
 * all-patients (`system/`) grant. Every projection renders from this one object.
 */
type GrantDraft = {
  readonly patient: string | null
} & Grant.Grant

/**
 * The starting picker draft. In request mode it is **seeded from `required`** so every
 * mandatory control the grid locks on (`spec.md §2`) is actually present in the draft —
 * without this a required cell renders locked-on while {@link serialize} emits nothing for
 * it. In open mode (`scopeRequest` `null`) it starts empty. `patient` carries the UI subject.
 */
const initial = (
  scopeRequest: ScopeRequest.ScopeRequest | null,
  patient: string | null = null
): GrantDraft => ({
  patient,
  ...(scopeRequest === null ? Grant.make([]) : scopeRequest.required),
})

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

export { type GrantDraft, initial, serialize, serializeAll }
