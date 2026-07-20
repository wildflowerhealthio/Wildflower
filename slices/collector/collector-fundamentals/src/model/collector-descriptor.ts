import { type Effect, Schema } from 'effect'
import { deepFreeze } from 'kitchen-sink'
import type { CollectorDisplay } from './collector-display.ts'
import {
  ResourcePersistenceRuntime,
  type FailedResource,
  type PersistFailure,
  type ResourcePersistenceContext,
  type ResourcePersistenceProgram,
} from './resource-persistence-runtime.ts'
import type * as ScrapingPlan from './scraping-plan.ts'

/*
 * This file defines "a collector" as one first-class value. The supporting
 * types each live in their own focused module and are re-exported here so
 * the `CollectorDescriptor.*` namespace stays the single import surface:
 *
 * - `CollectorDisplay`               → ./collector-display.ts            (user-facing strings)
 * - `FailedResource` / `PersistFailure`  → ./resource-persistence-runtime.ts (failure records)
 * - `ResourcePersistence{Context,    → ./resource-persistence-runtime.ts (the existential
 *   Program,Runtime}`                                                     write seam)
 *
 * What stays here is the descriptor itself and how it is authored/derived:
 * - `CollectorDescriptor` — the full value the registry/UI consume.
 * - `CollectorDescriptorSpec` — the author-supplied half a `*-client-collector`
 *   package writes; {@link make} adds the two derived `*IfMatches` guards.
 * - `ConfigOf` / `RequirementsOf` — type-level extractors the registry uses
 *   to derive the config union and the write-requirement union from the list.
 * - `make` — the frozen-identity factory.
 */

/**
 * Everything the registry and (stage 3) the UI need to treat "a
 * collector" as one first-class value instead of the four parallel
 * `registry.ts` edits it used to be (config union, tag literal,
 * resource union, dispatch switch).
 *
 * Each concrete `*-client-collector` package exports exactly one
 * `CollectorDescriptor`; `collector-registry` assembles them into an
 * ordered, closed, compile-time list and *derives* the config/tag
 * unions and the plan dispatch from it.
 *
 * The interface lives in `collector-fundamentals` — upstream of both
 * the client packages and the registry — so a client package can
 * depend on it without the `*-client-collector ↔ registry` cycle that
 * defining it in the registry would create.
 *
 * Nothing here assumes FHIR-ish config: `Config` is opaque and reached
 * only through `configSchema` (structural validation) and the
 * per-collector functions. A credential-based collector whose config
 * is `{ email, password }` (no `rootUrl`) is describable with the same
 * shape.
 *
 * Authored fields (see {@link CollectorDescriptorSpec}):
 * - `tag`: the config's discriminant (`Config['_tag']`); the registry
 *   derives `CollectorTag` from the set of these.
 * - `configSchema`: the `Schema` for this collector's per-instance
 *   config; the registry unions these into `CollectorConfig`.
 * - `defaultConfig`: a valid config to seed a new-instance form.
 * - `makeScrapingPlan`: the per-config plan *factory* (today's
 *   `scrapingPlan(config)`). Distinct from the already-applied
 *   `scrapingPlan` inside a {@link ResourcePersistenceContext}.
 * - `display`: the {@link CollectorDisplay} strings.
 * - `persistResources`: writes one decoded batch back to wherever this
 *   collector targets (for fhir-r4, the typed FHIR client). Owns *how* the
 *   batch is written — its own retries, per-resource spans, concurrency —
 *   and returns the resources it could not write as {@link PersistFailure}
 *   data (never failing, so one bad resource can't fail the run). The runner
 *   owns only *when* to write and how to fold the failures into the summary.
 *
 * Derived guards (added by {@link make}, not authored) — both exist so the
 * registry can dispatch over a heterogeneous descriptor list without an unsafe
 * cast: the per-descriptor `Config` narrowing happens here, where the concrete
 * type is still in scope, rather than in a loop over the union-typed list (where
 * TS collapses each element to the union and the schema's invariance defeats a
 * plain guard):
 * - `resourcePersistenceRuntimeIfMatches`: returns the config's existential
 *   {@link ResourcePersistenceRuntime} (plan + persistResources) when `config`
 *   is one of *its* configs (validated via `configSchema`), else `undefined`.
 *   The runner can then drive a matched config without naming `Resources`.
 * - `listSubtitleIfMatches`: returns `display.listSubtitle(config)` when `config`
 *   is one of *its* configs, else `undefined`. Lets a UI resolve a stored
 *   config's list subtitle without calling the config-parameterized
 *   `display.listSubtitle` on a union-typed descriptor (whose parameter collapses
 *   to `never`).
 */
interface CollectorDescriptor<Config extends { readonly _tag: string }, Resources, R> {
  readonly tag: Config['_tag']
  readonly configSchema: Schema.Schema<Config>
  readonly defaultConfig: Config
  readonly makeScrapingPlan: (config: Config) => ScrapingPlan.ScrapingPlan<Resources>
  readonly display: CollectorDisplay<Config>
  readonly persistResources: (
    resources: ReadonlyArray<Resources>
  ) => Effect.Effect<ReadonlyArray<PersistFailure>, never, R>
  readonly resourcePersistenceRuntimeIfMatches: (
    config: unknown
  ) => ResourcePersistenceRuntime<R> | undefined
  readonly listSubtitleIfMatches: (config: unknown) => string | undefined
}

/**
 * The author-supplied half of a descriptor: the fields a
 * `*-client-collector` package writes. {@link make} adds the derived
 * `resourcePersistenceRuntimeIfMatches` guard.
 */
interface CollectorDescriptorSpec<Config extends { readonly _tag: string }, Resources, R> {
  readonly tag: Config['_tag']
  readonly configSchema: Schema.Schema<Config>
  readonly defaultConfig: Config
  readonly makeScrapingPlan: (config: Config) => ScrapingPlan.ScrapingPlan<Resources>
  readonly display: CollectorDisplay<Config>
  readonly persistResources: (
    resources: ReadonlyArray<Resources>
  ) => Effect.Effect<ReadonlyArray<PersistFailure>, never, R>
}

/**
 * The `Config` a descriptor carries. Used by the registry to derive
 * `CollectorConfig` from the descriptor list via
 * `ConfigOf<(typeof descriptors)[number]>`.
 */
type ConfigOf<D> =
  D extends CollectorDescriptor<infer Config, infer _Resources, infer _R> ? Config : never

/**
 * The write requirement (`R`) a descriptor's `persistResources` needs.
 * Used by the registry to derive `CollectorRequirements` — the union of
 * every descriptor's `R`, which the authed runner must provide — via
 * `RequirementsOf<(typeof descriptors)[number]>`.
 */
type RequirementsOf<D> =
  D extends CollectorDescriptor<infer _Config, infer _Resources, infer R> ? R : never

/**
 * Build a frozen {@link CollectorDescriptor} from its authored spec,
 * matching the `EntityDefinition`/`ScrapingPlan` house style (an
 * identity factory that hands back an immutable value).
 *
 * The container and the descriptor's *own* data (`display`,
 * `defaultConfig`) are frozen. The shared library references —
 * `configSchema` and `makeScrapingPlan` — are deliberately *not*
 * deep-frozen: `configSchema` is the same `Schema` object the client
 * package exports, and `Object.freeze`-ing an Effect `Schema` in place
 * would mutate that module-level export for every other importer.
 * (Functions are opaque to `deepFreeze` anyway.)
 *
 * `resourcePersistenceRuntimeIfMatches` is derived here:
 * `Schema.is(spec.configSchema)` compiles the guard once, closing over the
 * concrete `Config` / `Resources` / `R`. When a config matches,
 * {@link ResourcePersistenceRuntime.make} seals the applied plan and the persist
 * sink behind the existential carrier, so the descriptor never spells out the
 * `{ run: (program) => program(context) }` plumbing.
 */
const make = <Config extends { readonly _tag: string }, Resources, R>(
  spec: CollectorDescriptorSpec<Config, Resources, R>
): CollectorDescriptor<Config, Resources, R> => {
  const isConfig = Schema.is(spec.configSchema)
  const resourcePersistenceRuntimeIfMatches = (
    config: unknown
  ): ResourcePersistenceRuntime<R> | undefined =>
    isConfig(config)
      ? ResourcePersistenceRuntime.make({
          scrapingPlan: spec.makeScrapingPlan(config),
          persistResources: spec.persistResources,
        })
      : undefined
  // Same narrowing rationale as above: `isConfig` narrows to the concrete
  // `Config` here, so `display.listSubtitle` is callable — a union-typed
  // descriptor's `listSubtitle` parameter collapses to `never`.
  const listSubtitleIfMatches = (config: unknown): string | undefined =>
    isConfig(config) ? spec.display.listSubtitle(config) : undefined
  // Freeze the descriptor's own data in place for its runtime-immutable
  // guarantee, but keep the precisely-typed references rather than
  // `deepFreeze`'s `DeepReadonly<Config>` return — for a generic
  // `Config`, `DeepReadonly<Config>` is opaque and would not re-widen
  // back to `Config`.
  deepFreeze(spec.defaultConfig)
  deepFreeze(spec.display)
  return Object.freeze({
    tag: spec.tag,
    configSchema: spec.configSchema,
    defaultConfig: spec.defaultConfig,
    makeScrapingPlan: spec.makeScrapingPlan,
    display: spec.display,
    persistResources: spec.persistResources,
    resourcePersistenceRuntimeIfMatches,
    listSubtitleIfMatches,
  })
}

export { make, ResourcePersistenceRuntime }
export type {
  CollectorDescriptor,
  CollectorDescriptorSpec,
  CollectorDisplay,
  ConfigOf,
  FailedResource,
  PersistFailure,
  RequirementsOf,
  ResourcePersistenceContext,
  ResourcePersistenceProgram,
}
