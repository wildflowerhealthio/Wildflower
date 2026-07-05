/**
 * The {@link MultiScope} — a set of scopes partitioned by kind (`fhirV1` / `fhirV2` /
 * `wildflower` / `known` / `unknown`), the shape shared by every "bag of scopes"
 * collection ({@link Grant}, {@link GrantDraft}, {@link ScopeRequest}). Each resource
 * partition is typed as its {@link BaseResourceScope} *base view* — keyed by the kind
 * literal, not the concrete class — so a client that wants one variant works generically on
 * `BaseResourceScope<…, TId>` (handed that partition via a {@link ScopeConfiguration}); a
 * client that needs the concrete union reaches for {@link Scope.ResourceScope.Any}.
 *
 * Every variant's `(context, resource, interaction)` triple lives once in {@link ResourceVariant},
 * the id→params map the whole partition algebra is keyed on. `MultiScope` is the *homomorphic
 * mapped type* over it ({@link MultiScope.Partitions}) plus the flag partitions, so pulling a
 * partition by one key — `partitions[id]` — lands on exactly `readonly ScopeOf<K>[]`, and a
 * cross-partition fold ({@link MultiScope.serialize}, {@link MultiScope.within}) can prove
 * `configuration.serialize(partitions[configuration.id])` correlates rather than collapsing to
 * an intersection parameter. Because a variant is recovered by *indexed access on one key*, the
 * view-model ({@link Cell.forItem}, the grid `Section`) is generic over that single `K` too.
 * The core cross-partition logic lives here so adding a variant touches {@link ResourceVariant}
 * plus its `configuration`.
 *
 * Namespace + type combo (`import { Scope } from 'scopes-core'` → `Scope.MultiScope`).
 */

import { Array } from 'effect'

import type * as Contexts from './contexts'
import FhirV1 from './fhir-scope-v1.ts'
import FhirV2 from './fhir-scope-v2.ts'
import type Known from './known.ts'
import type * as Permission from './permission'
import type * as ResourceType from './resource-type'
import type { BaseResourceScope, ScopeConfiguration } from './scope-configuration.ts'
import type Unknown from './unknown.ts'
import Wildflower from './wildflower-scope.ts'

/**
 * The type parameters of every resource-scope variant, keyed by its partition literal — the
 * single source of truth the partition algebra is generic over. Because a variant's context /
 * resource / interaction are recovered by *indexed access on one key*
 * (`ResourceVariant[K]['context']`, …) rather than four free generics, the compiler can prove
 * the id↔partition correlation a cross-partition fold needs, and each variant is described in
 * exactly one place. Adding a variant is one entry here plus its `configuration`.
 */
interface ResourceVariant {
  readonly fhirV1: {
    readonly context: Contexts.Fhir
    readonly resource: ResourceType.Fhir
    readonly interaction: Permission.ReadWrite.Interaction
  }
  readonly fhirV2: {
    readonly context: Contexts.Fhir
    readonly resource: ResourceType.Fhir
    readonly interaction: Permission.Cruds.Interaction
  }
  readonly wildflower: {
    readonly context: Contexts.Wildflower
    readonly resource: ResourceType.Wildflower
    readonly interaction: Permission.Cruds.Interaction
  }
}

/** A set of scopes partitioned by kind — each resource partition a base-typed `readonly ScopeOf<K>[]`. */
type MultiScope = MultiScope.Partitions & {
  readonly known: readonly Known[]
  readonly unknown: readonly Unknown[]
}

/** Any resource scope's base view — reach for {@link Scope.ResourceScope.Any} for the concrete union. */
type AnyResourceScope = { [K in MultiScope.Kind]: MultiScope.ScopeOf<K> }[MultiScope.Kind]

// oxlint-disable import/group-exports
namespace MultiScope {
  /** The resource partition literal — `'fhirV1' | 'fhirV2' | 'wildflower'`. */
  export type Kind = keyof ResourceVariant
  /** This variant's context, by partition literal. */
  export type ContextOf<K extends Kind> = ResourceVariant[K]['context']
  /** This variant's resource type, by partition literal. */
  export type ResourceOf<K extends Kind> = ResourceVariant[K]['resource']
  /** This variant's interaction (permission item), by partition literal. */
  export type InteractionOf<K extends Kind> = ResourceVariant[K]['interaction']
  /** This variant's resource scope, as its {@link BaseResourceScope} base view, by partition literal. */
  export type ScopeOf<K extends Kind> = BaseResourceScope<
    ContextOf<K>,
    ResourceOf<K>,
    InteractionOf<K>,
    K
  >
  /** The construction recipe for this variant's partition, keyed to its literal. */
  export type ConfigurationFor<K extends Kind> = ScopeConfiguration<
    ContextOf<K>,
    ResourceOf<K>,
    InteractionOf<K>,
    K
  >
  /**
   * The resource partitions alone (no flag partitions) — a *homomorphic mapped type*, so
   * indexing it by a single `K` reduces to this kind's `readonly ScopeOf<K>[]` (the seam every
   * correlated fold and {@link partition} pull goes through). `MultiScope` is this plus the flag
   * partitions; the fold helpers take `Partitions` so the index site is never an intersection.
   */
  export type Partitions = { readonly [K in Kind]: readonly ScopeOf<K>[] }

  /**
   * One resource configuration seen as the fold operations over *its own* partition, as a
   * distributive object type (`{ [P in K]: … }[K]`). Folding {@link resourceConfigurations}
   * hands each concrete configuration in as its own kind's member, so the compiler re-derives
   * the `ScopeOf<K>` partition per element — avoiding the union-of-methods → intersection-
   * parameter collapse a direct `configuration.serialize(partitions[configuration.id])` on the
   * union would hit. Every concrete `ScopeConfiguration` structurally satisfies its kind's member.
   */
  type Fold<K extends Kind> = {
    readonly [P in K]: {
      readonly id: P
      serialize(owned: readonly ScopeOf<P>[]): string[]
      within(grant: readonly ScopeOf<P>[], allowed: readonly ScopeOf<P>[]): boolean
    }
  }[K]

  /** The three resource-scope recipes, in canonical order — the fold's index. */
  export const resourceConfigurations = [
    FhirV1.configuration,
    FhirV2.configuration,
    Wildflower.configuration,
  ] as const

  /**
   * This kind's partition of `partitions`, correlated to `id` — the mapped-type index seam
   * ({@link Partitions}) a variant-generic caller pulls its homogeneous partition through
   * without a `Cruds | ReadWrite` union to collapse. Replaces the configuration's old `select`:
   * the knowledge of the bag's shape lives here, not on the (bag-agnostic) recipe.
   */
  export const partition = <K extends Kind>(partitions: Partitions, id: K): readonly ScopeOf<K>[] =>
    partitions[id]

  /** Serialize one configuration's own partition — correlated so no intersection parameter forms. */
  const serializePartition = <K extends Kind>(
    configuration: Fold<K>,
    partitions: Partitions
  ): string[] => configuration.serialize(partitions[configuration.id])

  /** Whether one configuration's `grant` partition is within its `allowed` partition (correlated). */
  const withinPartition = <K extends Kind>(
    configuration: Fold<K>,
    grant: Partitions,
    allowed: Partitions
  ): boolean => configuration.within(grant[configuration.id], allowed[configuration.id])

  /**
   * A {@link MultiScope} over a flat scope list, partitioned by `.kind` (kinds not present
   * get an empty partition). The structured-form constructor shared by every bag of scopes;
   * {@link Grant.make} re-exports it.
   */
  export const make = (
    scopes: readonly (FhirV1 | FhirV2 | Wildflower | Known | Unknown)[]
  ): MultiScope => ({
    unknown: [],
    known: [],
    fhirV1: [],
    fhirV2: [],
    wildflower: [],
    ...Array.groupBy(scopes, (s) => s.kind),
  })

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
    resourceConfigurations.flatMap((configuration) => serializePartition(configuration, ms))

  /**
   * Whether every resource partition of `grant` is within `allowed`'s (`spec.md §2`) — each
   * recipe checks its own partition ({@link ScopeConfiguration.within}). The flag-partition
   * subset check is a caller concern ({@link ScopeRequest.isWithin}).
   */
  export const within = (grant: MultiScope, allowed: MultiScope): boolean =>
    resourceConfigurations.every((configuration) => withinPartition(configuration, grant, allowed))
}

export { MultiScope }
