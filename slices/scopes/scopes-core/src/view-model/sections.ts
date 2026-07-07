/**
 * The {@link Sections} builder — the grid sections a {@link ScopeRequest.ScopeRequest}
 * derives, one per (variant kind, context) with a non-empty requested partition. A
 * {@link Section} is the input {@link Rows.build} (and `scopes-react`'s `PermissionGrid`)
 * projects: a single scope variant, its context, and the resources it lists. The
 * derivation groups the requested resource scopes by (kind, context) — each section's
 * resources are exactly the ones the app asked for there, never the whole vocabulary
 * (`spec.md §8`: no auto-complement) — with the `*` wildcard excluded, since the grid
 * injects that row itself ({@link Rows.build}, `spec.md §2/§3`). A view-model concern
 * with no `scopes-rust` counterpart.
 *
 * Namespace module (`import { Sections } from 'scopes-core'`).
 */

import { Scope } from '../domain/index.ts'
import type * as ScopeRequest from './scope-request.ts'

/**
 * One grid section — a single scope variant, its context, and the resources it lists
 * (`spec.md §1`). Generic over the single partition literal `K`: the `configuration` and
 * `context` are recovered from it by indexed access, so a Section is always *one concrete
 * variant* and every read stays within that variant's homogeneous partition.
 */
type Section<K extends Scope.MultiScope.Kind> = {
  /** The variant literal — a *direct* discriminant, so a union of Sections narrows on it. */
  readonly kind: K
  readonly configuration: Scope.MultiScope.ResourceScopeConfigurationFor<K>
  /** The section's context — `new Fhir('patient')`, `new Wildflower()`, … */
  readonly context: Scope.MultiScope.ContextOf<K>
  /** The resources to list as rows, in display order (`spec.md §4`). */
  readonly resources: readonly Scope.MultiScope.ResourceOf<K>[]
}

/** A section over any resource variant — a discriminated union on {@link Section.kind}. */
type Any = Section<'fhirV1'> | Section<'fhirV2'> | Section<'wildflower'>

/** The FHIR context levels a picker lists, in patient → user → system order. */
const fhirContextsInOrder: readonly Scope.Contexts.Fhir[] = [
  Scope.Contexts.Fhir.patient,
  Scope.Contexts.Fhir.user,
  Scope.Contexts.Fhir.system,
]

/**
 * The distinct resources of `scopes` (wildcard excluded — the grid injects the `*` row),
 * ordered by their position in `order`, with any resource not in `order` appended in
 * first-seen order — the row order a section renders in.
 */
const orderedResources = <K extends Scope.MultiScope.Kind>(
  scopes: readonly Scope.MultiScope.ScopeOf<K>[],
  order: readonly string[]
): Scope.MultiScope.ResourceOf<K>[] => {
  const seen = new Map<string, Scope.MultiScope.ResourceOf<K>>()
  for (const scope of scopes) {
    const name = scope.resource.serialize()
    if (name !== '*' && !seen.has(name)) seen.set(name, scope.resource)
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

/** Every FHIR section for one variant kind — one per context level present in the request. */
const fhirSectionsFor = <K extends 'fhirV1' | 'fhirV2'>(
  request: ScopeRequest.ScopeRequest,
  kind: K,
  configuration: Scope.MultiScope.ResourceScopeConfigurationFor<K>
): Section<K>[] => {
  const partition = Scope.MultiScope.partition(request.requested, kind)
  const sections: Section<K>[] = []
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

const wildflowerSectionsFor = (request: ScopeRequest.ScopeRequest): Section<'wildflower'>[] => {
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
const fromRequest = (request: ScopeRequest.ScopeRequest): Any[] => [
  ...fhirSectionsFor(request, 'fhirV2', Scope.FhirV2.configuration),
  ...fhirSectionsFor(request, 'fhirV1', Scope.FhirV1.configuration),
  ...wildflowerSectionsFor(request),
]

const scopePrefix = (section: Any): string => `${section.kind}/${section.context.serialize()}`

export { type Section, type Any, fromRequest, scopePrefix }
