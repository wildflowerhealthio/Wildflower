/**
 * The {@link MultiScope} — a set of scopes partitioned by kind (`fhirV1` / `fhirV2` /
 * `wildflower` / `known` / `unknown`), the shape shared by every "bag of scopes"
 * collection ({@link Grant}, {@link GrantDraft}, {@link ScopeRequest}). It's the level
 * at which a set "could contain anything"; a client that wants one variant works
 * generically on a scope `S` and is handed that variant's `readonly S[]` partition (via
 * a {@link ScopeConfiguration}). The core cross-partition logic (fold the resource
 * recipes over their partitions) lives here so adding a variant touches one place.
 *
 * Namespace + type combo (`import { Scope } from 'scopes-core'` → `Scope.MultiScope`).
 */

import FhirV1 from './fhir-scope-v1.ts'
import FhirV2 from './fhir-scope-v2.ts'
import type Known from './known.ts'
import type Unknown from './unknown.ts'
import Wildflower from './wildflower-scope.ts'

/** Every scope kind — the heterogeneous element of a {@link MultiScope}. */
type AnyScope = FhirV1 | FhirV2 | Wildflower | Known | Unknown

/** Any concrete resource-scope variant (the homogeneous element of a resource partition). */
type AnyResourceScope = FhirV1 | FhirV2 | Wildflower

/** A set of scopes partitioned by kind — each partition a homogeneous `readonly S[]`. */
type MultiScope = {
  readonly [K in AnyScope['kind']]: readonly Extract<AnyScope, { kind: K }>[]
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
