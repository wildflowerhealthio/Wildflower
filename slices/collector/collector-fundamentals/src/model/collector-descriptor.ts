import { type Effect, Schema } from 'effect'
import { deepFreeze } from 'kitchen-sink'
import type * as ScrapingPlan from './scraping-plan.ts'

/**
 * User-facing strings for one collector. Kept React-free here so the
 * descriptor stays importable by pure/native layers; `collector-react`
 * (stage 3A) consumes these to render the account list and the
 * "connect from" menu instead of the display strings currently
 * hardcoded in its routes.
 *
 * - `title`: the collector kind's name (e.g. "FHIR R4"). Distinct from
 *   a *remote's* user-chosen name and from a route's demo-entry label.
 * - `description`: one-line summary of what the collector imports.
 * - `listSubtitle`: derives the per-instance subtitle from a concrete
 *   config (e.g. the configured server URL). A function rather than a
 *   field because the salient detail differs per collector — the FHIR
 *   collector shows its `rootUrl`, a credential-based collector has no
 *   URL to show.
 */
interface CollectorDisplay<Config> {
  readonly title: string
  readonly description: string
  readonly listSubtitle: (config: Config) => string
}

/**
 * How the runner labels one resource in telemetry and in the `partial`
 * failure summary, without the runner ever naming a collector's resource
 * union. `kind` is a human/telemetry label (for FHIR, the `resourceType`);
 * `id` is the logical id the write targets. Produced by the descriptor's
 * {@link CollectorDescriptor.describeResource}.
 */
interface ResourceDescription {
  readonly kind: string
  readonly id: string
}

/**
 * The runner's per-config write ingredients, with the resource union
 * held **existential**. A collector's plan, its `persistResource`, and
 * its `describeResource` all range over the *same* concrete `Resources`,
 * but no consumer of the registry should have to name that union (the
 * whole point of retiring `AnyCollectorResource`). This CPS / rank-N
 * encoding hands the three, still tied to one hidden `Resources`, to a
 * generic continuation: the runner instantiates its own generic body
 * with the hidden type and returns a value that never mentions it (an
 * `Effect<ImportSummary, …, R>`), so the encoding is sound with no cast.
 *
 * `R` is the descriptor's write requirement (for fhir-r4,
 * `FhirR4ResourcesHttpApiClient`); the registry's lookup surfaces the
 * union of every descriptor's `R`, which the authed runner provides.
 */
interface RunIngredients<R> {
  readonly provide: <A>(
    run: <Resources>(bundle: {
      readonly scrapingPlan: ScrapingPlan.ScrapingPlan<Resources>
      readonly persistResource: (resource: Resources) => Effect.Effect<void, unknown, R>
      readonly describeResource: (resource: Resources) => ResourceDescription
    }) => A
  ) => A
}

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
 * - `tag`: the config's discriminant (`Config['_tag']`); the registry
 *   derives `CollectorTag` from the set of these.
 * - `configSchema`: the `Schema` for this collector's per-instance
 *   config; the registry unions these into `CollectorConfig`.
 * - `defaultConfig`: a valid config to seed a new-instance form.
 * - `makeScrapingPlan`: the per-config plan factory (today's
 *   `scrapingPlan(config)`).
 * - `display`: the {@link CollectorDisplay} strings.
 * - `persistResource`: writes one parsed resource back to wherever this
 *   collector targets (for fhir-r4, the typed FHIR client). "Which write
 *   goes where" only — the runner owns batching, `WRITE_CONCURRENCY`, the
 *   retry/backoff schedule, spans, and failure accounting.
 * - `describeResource`: the {@link ResourceDescription} for a resource,
 *   so the runner can label spans and report failures without naming the
 *   resource union.
 * - `scrapingPlanIfMatches`: a derived guard built by {@link make} —
 *   returns this collector's plan when `config` is one of *its* configs
 *   (validated via `configSchema`), else `undefined`. It exists so the
 *   registry can dispatch over a heterogeneous descriptor list without
 *   an unsafe cast: the per-descriptor `Config` narrowing happens here,
 *   where the concrete type is still in scope, rather than in a loop
 *   over the union-typed list (where TS collapses each element to the
 *   union and the schema's invariance defeats a plain guard).
 * - `runIngredientsIfMatches`: the same structural guard, returning the
 *   existential {@link RunIngredients} bundle (plan + persist + describe)
 *   so the runner can drive a matched config without naming `Resources`.
 */
interface CollectorDescriptor<Config extends { readonly _tag: string }, Resources, R> {
  readonly tag: Config['_tag']
  readonly configSchema: Schema.Schema<Config>
  readonly defaultConfig: Config
  readonly makeScrapingPlan: (config: Config) => ScrapingPlan.ScrapingPlan<Resources>
  readonly display: CollectorDisplay<Config>
  readonly persistResource: (resource: Resources) => Effect.Effect<void, unknown, R>
  readonly describeResource: (resource: Resources) => ResourceDescription
  readonly scrapingPlanIfMatches: (
    config: unknown
  ) => ScrapingPlan.ScrapingPlan<Resources> | undefined
  readonly runIngredientsIfMatches: (config: unknown) => RunIngredients<R> | undefined
}

/**
 * The author-supplied half of a descriptor: the fields a
 * `*-client-collector` package writes. {@link make} adds the derived
 * `scrapingPlanIfMatches` / `runIngredientsIfMatches` guards.
 */
interface CollectorDescriptorSpec<Config extends { readonly _tag: string }, Resources, R> {
  readonly tag: Config['_tag']
  readonly configSchema: Schema.Schema<Config>
  readonly defaultConfig: Config
  readonly makeScrapingPlan: (config: Config) => ScrapingPlan.ScrapingPlan<Resources>
  readonly display: CollectorDisplay<Config>
  readonly persistResource: (resource: Resources) => Effect.Effect<void, unknown, R>
  readonly describeResource: (resource: Resources) => ResourceDescription
}

/**
 * The `Config` a descriptor carries. Used by the registry to derive
 * `CollectorConfig` from the descriptor list via
 * `ConfigOf<(typeof descriptors)[number]>`.
 */
type ConfigOf<D> =
  D extends CollectorDescriptor<infer Config, infer _Resources, infer _R> ? Config : never

/**
 * The write requirement (`R`) a descriptor's `persistResource` needs.
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
 * `scrapingPlanIfMatches` and `runIngredientsIfMatches` are derived
 * here: `Schema.is(spec.configSchema)` compiles the guard once, closing
 * over the concrete `Config` / `Resources` / `R` so the
 * `spec.makeScrapingPlan(config)` call and the existential
 * {@link RunIngredients} bundle type-check with no cast.
 */
const make = <Config extends { readonly _tag: string }, Resources, R>(
  spec: CollectorDescriptorSpec<Config, Resources, R>
): CollectorDescriptor<Config, Resources, R> => {
  const isConfig = Schema.is(spec.configSchema)
  const scrapingPlanIfMatches = (
    config: unknown
  ): ScrapingPlan.ScrapingPlan<Resources> | undefined =>
    isConfig(config) ? spec.makeScrapingPlan(config) : undefined
  const runIngredientsIfMatches = (config: unknown): RunIngredients<R> | undefined =>
    isConfig(config)
      ? {
          provide: (run) =>
            run({
              scrapingPlan: spec.makeScrapingPlan(config),
              persistResource: spec.persistResource,
              describeResource: spec.describeResource,
            }),
        }
      : undefined
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
    persistResource: spec.persistResource,
    describeResource: spec.describeResource,
    scrapingPlanIfMatches,
    runIngredientsIfMatches,
  })
}

export { make }
export type {
  CollectorDescriptor,
  CollectorDescriptorSpec,
  CollectorDisplay,
  ConfigOf,
  RequirementsOf,
  ResourceDescription,
  RunIngredients,
}
