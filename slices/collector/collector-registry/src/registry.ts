import type { CollectorDescriptor } from 'collector-fundamentals/model'
import { Schema } from 'effect'
import { FhirR4CollectorDescriptor } from 'fhir-r4-client-collector'
import { RexallCollectorDescriptor } from 'rexall-be-well-collector'
import { WebTraceCollectorDescriptor } from 'web-trace-collector'

/**
 * The ordered, **closed, compile-time** list of every collector.
 *
 * This is the single edit point for registering a collector: add its
 * `*-client-collector` package as a dependency and append its
 * `CollectorDescriptor` here. Everything below — the {@link CollectorConfig}
 * union, the {@link CollectorTag} literal, {@link CollectorRequirements},
 * and the {@link resourcePersistenceRuntimeForConfig} dispatch — is *derived*
 * from this tuple, so there is no parallel switch/union to keep in sync (the
 * four parallel edits this file used to require; see issue #387). There
 * is intentionally no runtime registry.
 *
 * For the full end-to-end recipe (this edit plus the client-collector
 * package and the `collector-react` form registration), see
 * `slices/collector/docs/Adding a Collector How-To.md`.
 */
const descriptors = [
  FhirR4CollectorDescriptor,
  RexallCollectorDescriptor,
  WebTraceCollectorDescriptor,
] as const

type AnyCollectorDescriptor = (typeof descriptors)[number]

/**
 * Closed discriminated union of every collector's per-instance config,
 * derived from {@link descriptors}. The `CollectorApi.{Create,Update}Remote`
 * payloads and the host-side {@link resourcePersistenceRuntimeForConfig}
 * dispatch both flow from this single union.
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
 * The concrete config for a single {@link CollectorTag} — the member of the
 * {@link CollectorConfig} union whose `_tag` is `T`. Lets consumers stay generic
 * over a tag without erasing to the whole union (e.g. `collector-react`'s
 * `tag → form` registry keys each form to `ConfigForTag<its tag>`).
 *
 * `Extract` distributes over unions, so `ConfigForTag<CollectorTag>` collapses
 * back to `CollectorConfig` — a runtime-dispatch call site that only knows the
 * widened `CollectorTag` still typechecks against the full union.
 */
type ConfigForTag<T extends CollectorTag> = Extract<CollectorConfig, { readonly _tag: T }>

/**
 * The union of every collector's write requirement (`R`), derived from
 * the descriptors' `persistResources` sinks. This is the environment the
 * authed runner must provide for a {@link resourcePersistenceRuntimeForConfig}
 * program — today just `FhirR4ResourcesHttpApiClient`. Surfacing the union
 * here (rather than naming any resource type) is what lets
 * `AnyCollectorResource` disappear: consumers depend on *what the writes
 * need*, not on *which resources exist*.
 */
type CollectorRequirements = CollectorDescriptor.RequirementsOf<AnyCollectorDescriptor>

/**
 * Dispatch a stored `CollectorConfig` to the owning descriptor's
 * {@link CollectorDescriptor.ResourcePersistenceRuntime} — the config's
 * resolved plan + `persistResources`, with the resource
 * union held **existential**. The sync runner drives it by handing `.run` a
 * program, so it never names a collector's resource type. See
 * `collector-fundamentals/docs/Collector Sync Explanation.md`.
 *
 * Each descriptor's `resourcePersistenceRuntimeIfMatches` structurally
 * validates the config against *its own* schema (or returns `undefined`);
 * the first match wins. Registering a descriptor bundles its plan factory
 * and its persist sink, so there is no separate dispatch arm to forget —
 * the parallel switch this used to be (plus the FHIR write-switch in the
 * runner) is gone. The `throw` is unreachable for a well-typed
 * `CollectorConfig` (some descriptor always owns its `_tag`) and guards
 * only against a config smuggled in through an untyped path.
 */
const resourcePersistenceRuntimeForConfig = (
  config: CollectorConfig
): CollectorDescriptor.ResourcePersistenceRuntime<CollectorRequirements> => {
  for (const descriptor of descriptors) {
    const runtime = descriptor.resourcePersistenceRuntimeIfMatches(config)
    if (runtime !== undefined) {
      return runtime
    }
  }
  throw new Error(`unknown collector config tag: ${config._tag}`)
}

/**
 * The per-instance list subtitle for a stored config, dispatched to the owning
 * descriptor's `display.listSubtitle` with the config narrowed to that
 * descriptor's concrete type. Mirrors {@link resourcePersistenceRuntimeForConfig}:
 * each descriptor's `listSubtitleIfMatches` does the narrowing where its concrete
 * `Config` is in scope, so callers avoid the union-invariance trap of calling the
 * config-parameterized `descriptorForConfig(config)?.display.listSubtitle(config)`
 * directly (whose parameter collapses to `never` once more than one collector is
 * registered). Returns `''` for a config no descriptor owns (an untyped path).
 */
const listSubtitleForConfig = (config: CollectorConfig): string => {
  for (const descriptor of descriptors) {
    const subtitle = descriptor.listSubtitleIfMatches(config)
    if (subtitle !== undefined) {
      return subtitle
    }
  }
  return ''
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
  resourcePersistenceRuntimeForConfig,
  listSubtitleForConfig,
  descriptorForTag,
  descriptorForConfig,
}
export type { CollectorRequirements, AnyCollectorDescriptor, ConfigForTag }
