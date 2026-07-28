/**
 * The {@link Sections} builder — the grid sections a {@link ScopeRequest.ScopeRequest}
 * derives, one per (variant kind, context) with a non-empty requested partition. A
 * {@link ResourceSection} is the input {@link Rows.build} (and `scopes-react`'s `PermissionGrid`)
 * projects: a single scope variant, its context, and the resources it lists. The
 * derivation groups the requested resource scopes by (kind, context) — each section's
 * resources are exactly the ones the app asked for there, never the whole vocabulary
 * (`spec.md §8`: no auto-complement) — with the `*` wildcard excluded, since the grid
 * injects that row itself ({@link Rows.build}, `spec.md §2/§3`). A view-model concern
 * with no `scopes-rust` counterpart.
 *
 * Namespace module (`import { Sections } from 'scopes-core'`).
 */

import { Equal } from 'effect'

import { Scope } from '../domain/index.ts'
import type * as GrantDraft from './grant-draft.ts'
import * as ScopeRequest from './scope-request.ts'

/**
 * One grid section — a single scope variant, its context, and the resources it lists
 * (`spec.md §1`). Generic over the single partition literal `K`: the `configuration` and
 * `context` are recovered from it by indexed access, so a Section is always *one concrete
 * variant* and every read stays within that variant's homogeneous partition.
 */
type ResourceSection<K extends Scope.MultiScope.Kind> = {
  /** The variant literal — a *direct* discriminant, so a union of Sections narrows on it. */
  readonly kind: K
  readonly configuration: Scope.MultiScope.ResourceScopeConfigurationFor<K>
  /** The section's context — `new Fhir('patient')`, `new Wildflower()`, … */
  readonly context: Scope.MultiScope.ContextOf<K>
  /** The resources to list as rows, in display order (`spec.md §4`). */
  readonly resources: readonly Scope.MultiScope.ResourceOf<K>[]
}

/** A section over any resource variant — a discriminated union on {@link ResourceSection.kind}. */
type Any = ResourceSection<'fhirV1'> | ResourceSection<'fhirV2'> | ResourceSection<'wildflower'>

/** The FHIR context levels a picker lists, in patient → user → system order. */
const fhirContextsInOrder: readonly Scope.Contexts.Fhir[] = [
  Scope.Contexts.Fhir.patient,
  Scope.Contexts.Fhir.user,
  Scope.Contexts.Fhir.system,
]

/**
 * The distinct resources in `resources` (wildcard excluded — the grid injects the `*` row),
 * ordered by their position in `order`, with any resource not in `order` appended in
 * first-seen order — the row order a section renders in.
 */
const orderResources = <K extends Scope.MultiScope.Kind>(
  resources: readonly Scope.MultiScope.ResourceOf<K>[],
  order: readonly string[]
): Scope.MultiScope.ResourceOf<K>[] => {
  const seen = new Map<string, Scope.MultiScope.ResourceOf<K>>()
  for (const resource of resources) {
    const name = resource.serialize()
    if (name !== '*' && !seen.has(name)) seen.set(name, resource)
  }
  const known = new Set(order)
  const listed = order.flatMap((name) => {
    const resource = seen.get(name)
    return resource === undefined ? [] : [resource]
  })
  const unlisted = [...seen.entries()]
    .filter(([name]) => !known.has(name))
    .map(([, resource]) => resource)
  return [...listed, ...unlisted]
}

/** The row resources of `scopes` (wildcard excluded), in catalog `order`. */
const orderedResources = <K extends Scope.MultiScope.Kind>(
  scopes: readonly Scope.MultiScope.ScopeOf<K>[],
  order: readonly string[]
): Scope.MultiScope.ResourceOf<K>[] =>
  orderResources(
    scopes.map((scope) => scope.resource),
    order
  )

/** Every FHIR section for one variant kind — one per context level present in the request. */
const fhirSectionsFor = <K extends 'fhirV1' | 'fhirV2'>(
  request: ScopeRequest.ScopeRequest,
  kind: K,
  configuration: Scope.MultiScope.ResourceScopeConfigurationFor<K>
): ResourceSection<K>[] => {
  const partition = Scope.MultiScope.partition(request.requested, kind)
  const sections: ResourceSection<K>[] = []
  for (const context of fhirContextsInOrder) {
    const here = partition.filter((scope) => scope.hasContext(context))
    if (here.length === 0) continue
    sections.push({
      kind,
      configuration,
      context,
      resources: orderedResources(here, Scope.ResourceType.Fhir.catalog),
    })
  }
  return sections
}

const wildflowerSectionsFor = (
  request: ScopeRequest.ScopeRequest
): ResourceSection<'wildflower'>[] => {
  const wildflower = Scope.MultiScope.partition(request.requested, 'wildflower')

  if (wildflower.length > 0) {
    return [
      {
        kind: 'wildflower',
        configuration: Scope.Wildflower.configuration,
        context: new Scope.Contexts.Wildflower(),
        resources: orderedResources(wildflower, Scope.ResourceType.Wildflower.catalog),
      },
    ]
  }
  return []
}
/**
 * The grid sections for a request, one per (variant kind, context) with a non-empty
 * requested partition — FHIR v2 then v1 (each patient → user → system), then Wildflower
 * admin. Each section's resources are exactly the requested ones at that (kind, context),
 * wildcard excluded.
 */
const listFromRequest = (request: ScopeRequest.ScopeRequest): Any[] => [
  ...fhirSectionsFor(request, 'fhirV2', Scope.FhirV2.configuration),
  ...fhirSectionsFor(request, 'fhirV1', Scope.FhirV1.configuration),
  ...wildflowerSectionsFor(request),
]

/** A section's stable identity string (`${kind}/${contextSerialized}`) — render keys, row-key prefixes. */
const scopePrefix = (section: Any): string => `${section.kind}/${section.context.serialize()}`

/** The `${kind}/${contextSerialized}` prefix for a (kind, context) pair — the {@link extra} map key. */
const prefixFor = (kind: Scope.MultiScope.Kind, context: Scope.Contexts.Context): string =>
  `${kind}/${context.serialize()}`

/**
 * Resources the user added via "+ Add rule" but hasn't toggled yet, keyed by
 * {@link scopePrefix}: `sectionPrefix → resource names`. These rows are held in picker-local
 * state (never as empty-permission draft scopes, which would corrupt
 * {@link GrantDraft.hasScopes}); {@link listForDraft} folds them into their section so the empty
 * row renders until the first cell toggle creates the real scope.
 */
type ExtraResources = ReadonlyMap<string, readonly string[]>

/** Parse the {@link extra} names for one (kind, context) into resource objects (dropping unparseable). */
const extraResourcesFor = <K extends Scope.MultiScope.Kind>(
  configuration: Scope.MultiScope.ResourceScopeConfigurationFor<K>,
  extra: ExtraResources,
  kind: K,
  context: Scope.MultiScope.ContextOf<K>
): Scope.MultiScope.ResourceOf<K>[] =>
  (extra.get(prefixFor(kind, context)) ?? []).flatMap((name) => {
    const resource = configuration.resourceClass.parse(name)
    return resource === null ? [] : [resource]
  })

/**
 * The FHIR sections for one variant kind under {@link listForDraft}: one per context level that
 * carries a resource in `draft ∪ extra`, plus `activeContext` (the subject selector's choice —
 * always shown even when empty, so the picker has somewhere to add the first rule). Visibility
 * deliberately does NOT follow `requested` alone: the subject switch re-homes the whole draft
 * between contexts, and a requested-but-deselected context lingering as an empty section is
 * exactly the patient/system mixing the switch exists to avoid. A live grant can still never
 * hide — it's in the draft. A context is only offered when the grantable `available` envelope
 * covers it. A shown section's resources union `requested ∪ draft ∪ extra`, so
 * requested-but-pruned rows stay re-tickable and an expandable approval can add rows beyond
 * what was requested.
 */
const fhirSectionsForDraft = <K extends 'fhirV1' | 'fhirV2'>(
  request: ScopeRequest.ScopeRequest,
  draft: GrantDraft.GrantDraft,
  extra: ExtraResources,
  kind: K,
  configuration: Scope.MultiScope.ResourceScopeConfigurationFor<K>,
  activeContext: Scope.Contexts.Fhir | undefined
): ResourceSection<K>[] => {
  const requestedPart = Scope.MultiScope.partition(request.requested, kind)
  const draftPart = Scope.MultiScope.partition(draft, kind)
  const availablePart = Scope.MultiScope.partition(ScopeRequest.availableOf(request), kind)

  const sections: ResourceSection<K>[] = []
  for (const context of fhirContextsInOrder) {
    // Grantability guard: only offer a context the envelope can actually grant at.
    if (!availablePart.some((scope) => scope.context.covers(context))) continue

    const requestedHere = requestedPart.filter((scope) => scope.hasContext(context))
    const draftHere = draftPart.filter((scope) => scope.hasContext(context))
    const extraHere = extraResourcesFor(configuration, extra, kind, context)
    const isActive = activeContext !== undefined && Equal.equals(activeContext, context)
    if (draftHere.length === 0 && extraHere.length === 0 && !isActive) {
      continue
    }

    sections.push({
      kind,
      configuration,
      context,
      resources: orderResources(
        [
          ...requestedHere.map((scope) => scope.resource),
          ...draftHere.map((scope) => scope.resource),
          ...extraHere,
        ],
        Scope.ResourceType.Fhir.catalog
      ),
    })
  }
  return sections
}

/** The Wildflower admin section under {@link listForDraft} (shown when grantable or already touched). */
const wildflowerSectionForDraft = (
  request: ScopeRequest.ScopeRequest,
  draft: GrantDraft.GrantDraft,
  extra: ExtraResources
): ResourceSection<'wildflower'>[] => {
  const context = new Scope.Contexts.Wildflower()
  const requestedHere = Scope.MultiScope.partition(request.requested, 'wildflower')
  const draftHere = Scope.MultiScope.partition(draft, 'wildflower')
  const availableHere = Scope.MultiScope.partition(ScopeRequest.availableOf(request), 'wildflower')
  const extraHere = extraResourcesFor(Scope.Wildflower.configuration, extra, 'wildflower', context)
  if (
    requestedHere.length === 0 &&
    draftHere.length === 0 &&
    extraHere.length === 0 &&
    availableHere.length === 0
  ) {
    return []
  }
  return [
    {
      kind: 'wildflower',
      configuration: Scope.Wildflower.configuration,
      context,
      resources: orderResources(
        [
          ...requestedHere.map((scope) => scope.resource),
          ...draftHere.map((scope) => scope.resource),
          ...extraHere,
        ],
        Scope.ResourceType.Wildflower.catalog
      ),
    },
  ]
}

/**
 * The grid sections for an in-flight draft — the {@link listFromRequest} counterpart that also
 * surfaces resources the draft grants beyond `requested` and rows the user added via
 * "+ Add rule" (`extra`), so the **expandable** picker can build a grant up (not only prune it).
 * `activeContext` is the FHIR context the subject selector currently targets (shown even when
 * empty). Reduces to {@link listFromRequest} in clamped mode
 * (`available = requested`, `draft ⊆ requested`, empty `extra`, no `activeContext`).
 */
const listForDraft = (
  request: ScopeRequest.ScopeRequest,
  draft: GrantDraft.GrantDraft,
  extra: ExtraResources = new Map(),
  activeContext?: Scope.Contexts.Fhir
): Any[] => [
  ...fhirSectionsForDraft(
    request,
    draft,
    extra,
    'fhirV2',
    Scope.FhirV2.configuration,
    activeContext
  ),
  ...fhirSectionsForDraft(
    request,
    draft,
    extra,
    'fhirV1',
    Scope.FhirV1.configuration,
    activeContext
  ),
  ...wildflowerSectionForDraft(request, draft, extra),
]

export {
  type ResourceSection,
  type Any,
  type ExtraResources,
  listFromRequest,
  listForDraft,
  scopePrefix,
  prefixFor,
}
