import type { Effect } from 'effect'
import type { ResourceDescription } from './resource-description.ts'
import type * as ScrapingPlan from './scraping-plan.ts'

/**
 * One config's resolved persistence operations — its already-applied
 * `scrapingPlan`, its `persistResource`, and its `describeResource` — all
 * ranging over the *same* concrete `Resources`, which is held **hidden**
 * (existential). This is the value a {@link ResourcePersistenceProgram}
 * receives; no consumer of the registry ever names the resource union,
 * which is the whole point of retiring the cross-package
 * `AnyCollectorResource`.
 *
 * `R` (the write requirement — for fhir-r4, `FhirR4ResourcesHttpApiClient`)
 * is *not* hidden: it stays visible so the registry can surface the union
 * of every descriptor's `R` for the authed runner to provide.
 *
 * `scrapingPlan` here is the **already-applied** plan; the factory
 * (`makeScrapingPlan(config)`) lives on the `CollectorDescriptor`.
 *
 * See `docs/Collector Sync Explanation.md` for how Context / Program /
 * Runtime fit together, and for why this is an existential rather than an
 * Effect `Service`.
 */
interface ResourcePersistenceContext<Resources, R> {
  readonly scrapingPlan: ScrapingPlan.ScrapingPlan<Resources>
  readonly persistResource: (resource: Resources) => Effect.Effect<void, unknown, R>
  readonly describeResource: (resource: Resources) => ResourceDescription
}

/**
 * A resource-generic body: given a config's {@link ResourcePersistenceContext}
 * it produces some `A` that never mentions `Resources` (in practice the sync
 * runner's `Effect<ImportSummary, never, R>`). It is *generic* in `Resources`
 * so it cannot assume or name the concrete union — that genericity is what
 * makes opening the existential sound, with no cast.
 */
type ResourcePersistenceProgram<R, A> = <Resources>(
  context: ResourcePersistenceContext<Resources, R>
) => A

/**
 * The per-config existential carrier the registry hands back. You give
 * `run` a {@link ResourcePersistenceProgram}; it provides the config's
 * sealed {@link ResourcePersistenceContext} and returns the program's
 * result — "provide the context, get a runnable effect".
 *
 * At runtime this is trivial: `run` is a one-line "apply the program". The
 * only implementer is `CollectorDescriptor.make`, which closes over the
 * single hidden `Resources` it knows.
 */
interface ResourcePersistenceRuntime<R> {
  readonly run: <A>(program: ResourcePersistenceProgram<R, A>) => A
}

export type { ResourcePersistenceContext, ResourcePersistenceProgram, ResourcePersistenceRuntime }
