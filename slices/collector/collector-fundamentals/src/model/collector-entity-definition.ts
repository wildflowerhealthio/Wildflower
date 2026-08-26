import type { EntityDefinition } from 'http-extraction-fundamentals'
import { deepFreeze } from 'kitchen-sink'
import type { CollectorHttpResponse } from './collector-http-response.ts'
import type * as Step from './step.ts'

/**
 * An `http-extraction-fundamentals` `EntityDefinition`, extended with the one seam only a live
 * collector run can drive: reactive crawling via `followUpSteps`.
 *
 * @remarks
 * The base recipe — `name` / `isFoundAt` / `parse` — is
 * `http-extraction-fundamentals`' {@link EntityDefinition.EntityDefinition}, so a
 * source package's entities feed a `ScrapingPlan` unchanged (the extra
 * member is optional). What this type adds exists only live: generated
 * `Step`s drive *navigation*, and an archive-driven extraction has nothing to
 * navigate.
 *
 * - `followUpSteps` (optional): the declared, statically-visible seam for
 *   reactive crawling. Every time this entity's `parse` succeeds, the handler
 *   calls it with the just-parsed resources and the settled
 *   {@link CollectorHttpResponse}, and appends whatever `Step`s it returns to the
 *   back of the automatic-navigation queue (breadth-first). It is **pure and
 *   synchronous** — a plain `resources → steps` function, not an `Effect` — so
 *   generation is visible at the definition site and its invocation is owned by
 *   the handler, not hidden inside `parse`. `response` is passed alongside the
 *   parsed resources so a generator can resolve relative links against
 *   `response.url` (e.g. open every entry linked from a list/table). Run-wide
 *   dedup of generated `Open`s by URI and a `ScrapingPlan.maxGeneratedSteps`
 *   cap (enforced by the handler, not here) keep the naturally-recursive
 *   fan-out terminating. Omit it for a leaf entity that never spawns work. Each
 *   generated `Step` must carry a `name` (as any authored step does) — it labels
 *   the sniffer chrome as the generated step runs.
 *
 *   Generation is a separate, named field rather than a `parse` side-channel, so
 *   `parse` stays a pure decode with no hidden control flow, and the handler —
 *   not the decode — owns when generation runs.
 */
interface CollectorEntityDefinition<
  TResources,
> extends EntityDefinition.EntityDefinition<TResources> {
  // Declared as a *method* signature, not a `readonly` arrow property, on
  // purpose: `resources` puts `TResources` in a parameter (contravariant)
  // position, which would make `CollectorEntityDefinition` — and thus
  // `ScrapingPlan` — invariant in `TResources`, breaking the
  // `ScrapingPlan<Resources>` → `ScrapingPlan<unknown>` widening the
  // sealed-`Resources` existential relies on. Method parameters are checked
  // bivariantly, so this keeps the type covariant (as the base
  // `EntityDefinition` is) while still typing the generator precisely.
  followUpSteps?(resources: readonly TResources[], response: CollectorHttpResponse): readonly Step.Step[]
}

/**
 * Shallow-clone + deep-freeze the supplied definition so callers
 * cannot mutate `entityDefinitions` (via `ScrapingPlan.make`) after
 * construction — the dispatcher pins the matched entity per request
 * at `ResponseStart` and assumes it stays put. The clone copies the
 * known fields (`name`, `isFoundAt`, `parse`, and the optional
 * `followUpSteps`) so an extra unexpected property on the caller's
 * object is silently dropped.
 */
const make = <TResources>(
  definition: CollectorEntityDefinition<TResources>
): CollectorEntityDefinition<TResources> =>
  deepFreeze({
    name: definition.name,
    isFoundAt: definition.isFoundAt,
    parse: definition.parse,
    // `followUpSteps` is declared as a method (for covariance — see the interface
    // note), so copying the reference trips `unbound-method`; it is a pure,
    // `this`-free function, so the concern (unintended `this` scoping) can't apply.
    // oxlint-disable-next-line typescript-eslint/unbound-method -- pure, this-free method; the copy is safe
    followUpSteps: definition.followUpSteps,
  })

export { make }
export type { CollectorEntityDefinition }
