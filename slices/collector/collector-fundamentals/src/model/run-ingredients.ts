import type { Effect } from 'effect'
import type { ResourceDescription } from './resource-description.ts'
import type * as ScrapingPlan from './scraping-plan.ts'

/**
 * The runner's per-config write ingredients, with the resource union held
 * **existential**. A collector's plan, its `persistResource`, and its
 * `describeResource` all range over the *same* concrete `Resources`, but
 * no consumer of the registry should have to name that union — that is the
 * whole point of retiring the cross-package `AnyCollectorResource`.
 *
 * ## Why this shape (and not an Effect `Service`)
 *
 * A reviewer will reasonably ask "why the hand-rolled callback — can't the
 * ingredients just be an Effect `Service`/`Layer` that gets provided?" They
 * cannot, and the distinction is the reason this type exists:
 *
 * - An Effect `Service` (`Context.Tag<Id, Value>`) hides a **value** in the
 *   `R` channel and looks it up at the value level. It does **not** hide a
 *   **type parameter**. A `Service` carrying these three functions would
 *   still have to name `Resources` in its type (`Ingredients<Resources>`),
 *   pushing the union back onto every consumer — exactly what we are
 *   removing.
 * - What must be hidden here is the *type* `Resources`, not a value. That is
 *   an **existential** (`∃Resources. { plan, persist, describe }`), which
 *   TypeScript expresses via this CPS / rank-2 encoding: `runWith` takes a
 *   continuation that is itself generic in `Resources`, so the caller cannot
 *   assume or name the concrete union. The one implementer ({@link make} in
 *   `collector-descriptor.ts`) applies the continuation to the single hidden
 *   `Resources` it closed over and returns whatever the continuation returns
 *   — a value that never mentions `Resources` (an `Effect<…, …, R>`). Sound,
 *   with no cast.
 *
 * `R` (the write requirement — for fhir-r4, `FhirR4ResourcesHttpApiClient`)
 * is deliberately **not** hidden: it stays a visible parameter so the
 * registry can surface the union of every descriptor's `R` for the authed
 * runner to provide. Only `Resources` is existential.
 *
 * At runtime this is trivial — the whole encoding is type-level; `runWith`
 * is a one-line "apply the continuation". Producer: {@link make} (the only
 * implementation). Consumer: `runIngredientsForConfig(config).runWith(run)`
 * in `collector-registry` / the sync runner.
 *
 * Note `scrapingPlan` below is the **already-applied** plan (the descriptor's
 * `makeScrapingPlan` has been called with the config), not the factory — the
 * factory name lives on the descriptor as `makeScrapingPlan`.
 */
interface RunIngredients<R> {
  readonly runWith: <A>(
    run: <Resources>(bundle: {
      readonly scrapingPlan: ScrapingPlan.ScrapingPlan<Resources>
      readonly persistResource: (resource: Resources) => Effect.Effect<void, unknown, R>
      readonly describeResource: (resource: Resources) => ResourceDescription
    }) => A
  ) => A
}

export type { RunIngredients }
