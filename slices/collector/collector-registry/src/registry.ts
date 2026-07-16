import type { CollectorDescriptor } from 'collector-fundamentals/model'
import { Schema } from 'effect'
import { FhirR4CollectorDescriptor } from 'fhir-r4-client-collector'

/**
 * The ordered, **closed, compile-time** list of every collector.
 *
 * This is the single edit point for registering a collector: add its
 * `*-client-collector` package as a dependency and append its
 * `CollectorDescriptor` here. Everything below — the {@link CollectorConfig}
 * union, the {@link CollectorTag} literal, {@link CollectorRequirements},
 * and the {@link runIngredientsForConfig} dispatch — is *derived* from
 * this tuple, so there is no parallel switch/union to keep in sync (the
 * four parallel edits this file used to require; see issue #387). There
 * is intentionally no runtime registry.
 */
const descriptors = [FhirR4CollectorDescriptor] as const

type AnyCollectorDescriptor = (typeof descriptors)[number]

/**
 * Closed discriminated union of every collector's per-instance config,
 * derived from {@link descriptors}. The `CollectorApi.{Create,Update}Remote`
 * payloads and the host-side {@link runIngredientsForConfig} dispatch
 * both flow from this single union.
 *
 * The runtime schema is the `Schema.Union` of each descriptor's
 * `configSchema`; the type is derived from the same list via
 * `ConfigOf`, and the `Schema.Schema<CollectorConfig>` annotation locks
 * the two together — a descriptor whose config isn't reflected in the
 * derived type is a compile error rather than a silent wire drift.
 */
type CollectorConfig = CollectorDescriptor.ConfigOf<AnyCollectorDescriptor>
const CollectorConfig: Schema.Schema<CollectorConfig> = Schema.Union(
  ...descriptors.map((descriptor) => descriptor.configSchema)
)

/**
 * The narrow set of `_tag` literals the union admits, derived from the
 * same {@link descriptors} list. Used as the schema of a remote's wire
 * `tag` field.
 *
 * Annotated as `Schema.Schema<CollectorTag>` (where `CollectorTag =
 * CollectorConfig['_tag']`) so the literal list stays locked to the
 * config union — adding a collector without its tag flowing through is
 * a compile error, preserving the previous hand-written `Schema.Literal`
 * lock.
 */
type CollectorTag = CollectorConfig['_tag']
const CollectorTag: Schema.Schema<CollectorTag> = Schema.Literal(
  ...descriptors.map((descriptor) => descriptor.tag)
)

/**
 * The union of every collector's write requirement (`R`), derived from
 * the descriptors' `persistResource` sinks. This is the environment the
 * authed runner must provide for {@link runIngredientsForConfig}'s bundle
 * — today just `FhirR4ResourcesHttpApiClient`. Surfacing the union here
 * (rather than naming any resource type) is what lets `AnyCollectorResource`
 * disappear: consumers depend on *what the writes need*, not on *which
 * resources exist*.
 */
type CollectorRequirements = CollectorDescriptor.RequirementsOf<AnyCollectorDescriptor>

/**
 * Build the run ingredients (plan + `persistResource` + `describeResource`)
 * for a stored `CollectorConfig` by dispatching to the owning descriptor,
 * with the resource union held **existential** (see
 * {@link CollectorDescriptor.RunIngredients}). Drives the sync runner: it
 * consumes the returned bundle through the `runWith` continuation, so it
 * never names a collector's resource type.
 *
 * Each descriptor's `runIngredientsIfMatches` structurally validates the
 * config against *its own* schema and returns its bundle (or `undefined`);
 * the first match wins. Registering a descriptor bundles its plan factory
 * and its persist sink, so there is no separate dispatch arm to forget —
 * the parallel switch this used to be (plus the FHIR write-switch in the
 * runner) is gone. The `throw` is unreachable for a well-typed
 * `CollectorConfig` (some descriptor always owns its `_tag`) and guards
 * only against a config smuggled in through an untyped path.
 */
const runIngredientsForConfig = (
  config: CollectorConfig
): CollectorDescriptor.RunIngredients<CollectorRequirements> => {
  for (const descriptor of descriptors) {
    const ingredients = descriptor.runIngredientsIfMatches(config)
    if (ingredients !== undefined) {
      return ingredients
    }
  }
  throw new Error(`unknown collector config tag: ${config._tag}`)
}

/**
 * Look up the descriptor that owns a `_tag`, for stage-3 consumers that
 * need a collector's `display` / `defaultConfig` / schema. Returns
 * `undefined` for an unregistered tag.
 */
const descriptorForTag = (tag: CollectorTag): AnyCollectorDescriptor | undefined =>
  descriptors.find((descriptor) => descriptor.tag === tag)

/**
 * Look up the descriptor that owns a stored config. Convenience wrapper
 * over {@link descriptorForTag} keyed on `config._tag`.
 */
const descriptorForConfig = (config: CollectorConfig): AnyCollectorDescriptor | undefined =>
  descriptorForTag(config._tag)

export {
  descriptors,
  CollectorConfig,
  CollectorTag,
  runIngredientsForConfig,
  descriptorForTag,
  descriptorForConfig,
}
export type { CollectorRequirements, AnyCollectorDescriptor }
