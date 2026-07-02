/**
 * The {@link MultiScope} — a set of scopes partitioned by kind (`fhirV1` / `fhirV2` /
 * `wildflower` / `known` / `unknown`), the shape shared by every "bag of scopes"
 * collection ({@link Grant}, {@link GrantDraft}, {@link ScopeRequest}). Each resource
 * partition is typed as its {@link BaseResourceScope} *base view* — keyed by the kind
 * literal, but not the concrete class — so a client that wants one variant works
 * generically on `BaseResourceScope<TContext, TResource, TInteraction, TId>` (handed that
 * partition via a {@link ScopeConfiguration}); a client that needs the concrete union
 * reaches for {@link Scope.ResourceScope.Any}. The core cross-partition logic (fold the
 * resource recipes over their partitions) lives here so adding a variant touches one place.
 *
 * Namespace + type combo (`import { Scope } from 'scopes-core'` → `Scope.MultiScope`).
 */

import type * as Contexts from './contexts'
import FhirV1 from './fhir-scope-v1.ts'
import FhirV2 from './fhir-scope-v2.ts'
import type Known from './known.ts'
import type * as Permission from './permission'
import type * as ResourceType from './resource-type'
import type { BaseResourceScope } from './scope.ts'
import type Unknown from './unknown.ts'
import Wildflower from './wildflower-scope.ts'

/** A FHIR v1 (Read/Write word) resource scope, as its base view. */
type FhirV1Scope = BaseResourceScope<
  Contexts.Fhir,
  ResourceType.Fhir,
  Permission.ReadWrite.Interaction,
  'fhirV1'
>
/** A FHIR v2 (cruds) resource scope, as its base view. */
type FhirV2Scope = BaseResourceScope<
  Contexts.Fhir,
  ResourceType.Fhir,
  Permission.Cruds.Interaction,
  'fhirV2'
>
/** A Wildflower admin (cruds) resource scope, as its base view. */
type WildflowerScope = BaseResourceScope<
  Contexts.Wildflower,
  ResourceType.Wildflower,
  Permission.Cruds.Interaction,
  'wildflower'
>

/** Any resource scope's base view — reach for {@link Scope.ResourceScope.Any} for the concrete union. */
type AnyResourceScope = FhirV1Scope | FhirV2Scope | WildflowerScope

/** A set of scopes partitioned by kind — each resource partition a base-typed `readonly S[]`. */
type MultiScope = {
  readonly fhirV1: readonly FhirV1Scope[]
  readonly fhirV2: readonly FhirV2Scope[]
  readonly wildflower: readonly WildflowerScope[]
  readonly known: readonly Known[]
  readonly unknown: readonly Unknown[]
}

// oxlint-disable import/group-exports
namespace MultiScope {
  /** The three resource-scope recipes, in canonical order — the fold's index. */
  export const resourceConfigurations = [
    FhirV1.configuration,
    FhirV2.configuration,
    Wildflower.configuration,
  ] as const

  /** The resource scopes (FHIR + Wildflower) across a bag's partitions, in kind order. */
  export const resourceScopes = (ms: MultiScope): AnyResourceScope[] => [
    ...ms.fhirV1,
    ...ms.fhirV2,
    ...ms.wildflower,
  ]

  /**
   * Every resource partition's wire strings with per-partition `spec.md §3` dedupe —
   * each recipe serializes its own partition ({@link ScopeConfiguration.serialize}). The
   * cross-partition de-dup + sort is a caller concern ({@link GrantDraft.serialize}).
   */
  export const serialize = (ms: MultiScope): string[] =>
    resourceConfigurations.flatMap((configuration) => configuration.serialize(ms))
}

export { MultiScope }
