import type { Effect } from 'effect'
import type * as ScrapingPlan from './scraping-plan.ts'

/**
 * Identity of one resource in a write span and in a failure record: a
 * free-form `label` (for fhir, the `resourceType`) plus the logical `id` the
 * write targets. NOT a discriminant — nothing switches on `label`; it only
 * names the resource in telemetry and in the runner's `partial` summary. The
 * descriptor's persist sink produces these, so the runner surfaces a failed
 * resource without ever naming a collector's resource union.
 */
interface FailedResource {
  readonly label: string
  readonly id: string
}

/**
 * One resource the persist sink could not write after its retries (or a
 * response that failed to parse), paired with the underlying `cause`. The
 * batch sink returns these **as data** — its Effect never fails — so one bad
 * resource cannot fail the whole run. The runner folds them into the `partial`
 * summary and fires `onError(cause)` with the real error, so the screen shows
 * the true failure rather than a synthesized one.
 */
interface PersistFailure {
  readonly failed: FailedResource
  readonly cause: unknown
}

/**
 * One config's resolved persistence operations — its already-applied
 * `scrapingPlan` and its batch `persistResources` — over the *same* concrete
 * `Resources`, held **hidden** (existential). This is the value a
 * {@link ResourcePersistenceProgram} receives; no consumer of the registry
 * ever names the resource union, which is the whole point of retiring the
 * cross-package `AnyCollectorResource`.
 *
 * `persistResources` takes the whole decoded batch (not one resource at a
 * time) so a sink can exploit a bulk-insert endpoint. It returns the resources
 * it could not write as {@link PersistFailure} data on a `never` error channel:
 * one bad resource cannot fail the run, and the runner's failure accounting
 * reads straight off the return. The sink owns everything about *how* a batch
 * is written — retries, per-resource spans, concurrency.
 *
 * `R` (the write requirement — for fhir-r4, `FhirR4ResourcesHttpApiClient`) is
 * *not* hidden: it stays visible so the registry can surface the union of
 * every descriptor's `R` for the authed runner to provide.
 *
 * `scrapingPlan` here is the **already-applied** plan; the factory
 * (`makeScrapingPlan(config)`) lives on the `CollectorDescriptor`.
 *
 * See `docs/Collector Sync Explanation.md` for how Context / Program / Runtime
 * fit together, and for why this is an existential rather than an Effect
 * `Service`.
 */
interface ResourcePersistenceContext<Resources, R> {
  readonly scrapingPlan: ScrapingPlan.ScrapingPlan<Resources>
  readonly persistResources: (
    resources: ReadonlyArray<Resources>
  ) => Effect.Effect<ReadonlyArray<PersistFailure>, never, R>
  /**
   * The framework-minted id of this run, sealed alongside the plan that was
   * built with it — a runtime instance *is* one run. The runner hands it to
   * `CollectorBridgeMessageHandler.make` so the plan's `captureProvenance`
   * hook (and anything else run-scoped) shares one identity, minted once.
   */
  readonly runId: string
}

/**
 * A resource-generic body: given a config's {@link ResourcePersistenceContext}
 * it produces an `Effect<A, never, R>` that never mentions `Resources` (in
 * practice the sync runner's `Effect<ImportSummary, never, R>`). It is
 * *generic* in `Resources` so it cannot assume or name the concrete union —
 * that genericity is what makes opening the existential sound, with no cast.
 *
 * `A` is left unconstrained on purpose. In production every program returns an
 * `Effect` — the runner's one concrete program is
 * `(context) => buildImportEffect(...)`, whose `A` is
 * `Effect<ImportSummary, never, R>`. But pinning `A = Effect<…>` here would buy
 * nothing: the existential is already sound because `A` cannot mention the
 * hidden `Resources`, effectful or not. It would only make the existential
 * harder to *observe* — a caller that reads `context.scrapingPlan` back out
 * through `run` (as the registry/descriptor tests do) would then have to run an
 * Effect and provide `R` to look at a pure value. So the result stays `A`.
 */
type ResourcePersistenceProgram<R, A> = <Resources>(
  context: ResourcePersistenceContext<Resources, R>
) => A

/**
 * The per-config existential carrier the registry hands back. You give `run` a
 * {@link ResourcePersistenceProgram}; it provides the config's sealed
 * {@link ResourcePersistenceContext} and returns the program's result. In
 * production that result is the sync runner's `Effect<ImportSummary, never, R>`.
 *
 * The only constructor is {@link ResourcePersistenceRuntime.make}; `run` is
 * then a one-line "apply the program to the sealed context".
 */
interface ResourcePersistenceRuntime<R> {
  readonly run: <A>(program: ResourcePersistenceProgram<R, A>) => A
}

/**
 * Seal a concrete-`Resources` {@link ResourcePersistenceContext} behind a
 * {@link ResourcePersistenceRuntime}, hiding the `Resources` type from every
 * consumer. `Resources` is a free type parameter of `make` yet appears nowhere
 * in the return type, so it is existentially quantified: a caller reaches the
 * context only by handing `run` a `Resources`-generic program, and the single
 * hidden `Resources` is applied to that program here. Sound, with no cast.
 *
 * This factory is where the existential is *introduced*; keeping it here (not
 * inline in `CollectorDescriptor.make`) means the descriptor never spells out
 * the `{ run: (program) => program(context) }` plumbing.
 */
const ResourcePersistenceRuntime = {
  make: <Resources, R>(
    context: ResourcePersistenceContext<Resources, R>
  ): ResourcePersistenceRuntime<R> => ({
    run: (program) => program(context),
  }),
}

export { ResourcePersistenceRuntime }
export type {
  FailedResource,
  PersistFailure,
  ResourcePersistenceContext,
  ResourcePersistenceProgram,
}
