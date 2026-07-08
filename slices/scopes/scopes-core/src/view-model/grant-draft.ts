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
 * Seed a draft from a flat scope list, with every scope checked — {@link Grant.parse}
 * partitions the strings (total, nothing dropped) and `patient` carries the UI subject.
 * Used for the consent form's all-optional seeding: start with every *requested* scope
 * already granted, so the user prunes rather than builds. The request-mode counterpart is
 * {@link initial}, which seeds only the mandatory `required` subset.
 */
const fromScopes = (scopes: Iterable<string>, patient: string | null = null): GrantDraft => ({
  patient,
  ...Grant.parse(scopes),
})

/**
 * Per-kind resource-partition write-backs, correlated to the partition literal so a
 * variant-generic {@link toggleItem} can replace `draft[id]` without a cast or a generic
 * computed key (`{ ...draft, [id]: next }` loses the correlation and won't typecheck). Indexing
 * this homomorphic record by a single `K` recovers exactly that kind's `readonly ScopeOf<K>[]`
 * updater — the same correlated-fold seam {@link Scope.MultiScope} uses for its partitions.
 */
const resourcePartitionUpdaters: {
  [K in Scope.MultiScope.Kind]: (
    draft: GrantDraft,
    partition: readonly Scope.MultiScope.ScopeOf<K>[]
  ) => GrantDraft
} = {
  fhirV1: (draft, partition) => ({ ...draft, fhirV1: partition }),
  fhirV2: (draft, partition) => ({ ...draft, fhirV2: partition }),
  wildflower: (draft, partition) => ({ ...draft, wildflower: partition }),
}

/**
 * Toggle one interaction cell on a draft, returning the NEW draft — delegates the partition
 * edit to the variant's {@link Scope.ResourceScopeConfiguration.toggleItem} (add / remove, split-row
 * merge, emptied-row drop, wildcard-lock no-op all live there) and writes the resulting
 * partition back immutably via {@link resourcePartitionUpdaters}. Generic over the single
 * partition literal `K`, so `configuration`, `context`, `resource` and `itemId` are all the
 * one variant's own values with no free generics to mismatch.
 */
const toggleItem = <K extends Scope.MultiScope.Kind>(
  draft: GrantDraft,
  configuration: Scope.MultiScope.ResourceScopeConfigurationFor<K>,
  context: Scope.MultiScope.ContextOf<K>,
  resource: Scope.MultiScope.ResourceOf<K>,
  itemId: Scope.MultiScope.InteractionOf<K>
): GrantDraft => {
  const next = configuration.toggleItem(
    Scope.MultiScope.partition(draft, configuration.id),
    context,
    resource,
    itemId
  )
  return resourcePartitionUpdaters[configuration.id](draft, next)
}

/**
 * Flip a known (flag) scope on a draft, returning the NEW draft — delegates to the flag
 * editing algebra ({@link Scope.Known.toggleFlag}, idempotent set membership, `spec.md §7`)
 * and writes the `known` partition back immutably. The flag-scope counterpart of
 * {@link toggleItem}.
 */
const toggleFlag = (draft: GrantDraft, name: Scope.Known.Name): GrantDraft => ({
  ...draft,
  known: Scope.Known.toggleFlag(draft.known, name),
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

/**
 * Whether the draft grants at least one scope (resource, flag, or unknown) — i.e.
 * whether {@link serializeAll} is non-empty. An empty draft is a no-op the backend
 * treats as a *deny* (`grantable_scopes` yields nothing), so an approve surface must
 * gate its action on this rather than let a fully-pruned draft submit as an accidental
 * denial. Checks the partitions directly, without building the sorted wire list.
 */
const hasScopes = (grant: GrantDraft): boolean =>
  grant.fhirV1.length > 0 ||
  grant.fhirV2.length > 0 ||
  grant.wildflower.length > 0 ||
  grant.known.length > 0 ||
  grant.unknown.length > 0

export {
  type GrantDraft,
  initial,
  fromScopes,
  toggleItem,
  toggleFlag,
  serialize,
  serializeAll,
  hasScopes,
}
