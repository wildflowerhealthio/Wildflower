import type { HttpResponseKind } from 'http-extraction-fundamentals'
import { deepFreeze } from 'kitchen-sink'
import type { CollectorHttpResponse } from './collector-http-response.ts'
import type * as Step from './step.ts'

/**
 * An `http-extraction-fundamentals` `HttpResponseKind`, extended with the one seam only a live
 * collector run can drive: reactive crawling via `followUpSteps`.
 *
 * @remarks
 * The base recipe — `name` / `tryRecognize` / `parse` — is
 * `http-extraction-fundamentals`' {@link HttpResponseKind.HttpResponseKind}, so a
 * source package's entities feed a `ScrapingPlan` unchanged (the extra
 * member is optional). What this type adds exists only live: generated
 * `Step`s drive *navigation*, and an archive-driven extraction has nothing to
 * navigate.
 *
 * `followUpSteps` (optional) is the declared, statically-visible seam for
 * reactive crawling — a separate, named field rather than a `parse`
 * side-channel, so `parse` stays a pure decode and the handler owns when
 * generation runs. It is **pure and synchronous** — a plain
 * `resources → steps` function, not an `Effect`. Every time this entity's
 * `parse` succeeds, the handler calls it with the just-parsed resources and
 * the settled {@link CollectorHttpResponse} (so a generator can resolve
 * relative links against `response.url`) and appends the returned `Step`s —
 * each carrying a `name`, like any authored step — to the back of the
 * automatic-navigation queue. The termination guards (run-wide `Open` dedup,
 * `maxGeneratedSteps`) are the handler's, not this type's — see the slice
 * AGENTS.md. Omit it for a leaf entity that never spawns work.
 */
interface CollectorHttpResponseKind<TParsed> extends HttpResponseKind.HttpResponseKind<TParsed> {
  // Declared as a *method* signature, not a `readonly` arrow property, on
  // purpose: `resources` puts `TParsed` in a parameter (contravariant)
  // position, which would make `CollectorHttpResponseKind` — and thus
  // `ScrapingPlan` — invariant in `TParsed`, breaking the
  // `ScrapingPlan<Resources>` → `ScrapingPlan<unknown>` widening the
  // sealed-`Resources` existential relies on. Method parameters are checked
  // bivariantly, so this keeps the type covariant (as the base
  // `HttpResponseKind` is) while still typing the generator precisely.
  followUpSteps?(
    resources: readonly TParsed[],
    response: CollectorHttpResponse
  ): readonly Step.Step[]
}

/**
 * Same clone-and-freeze contract as the base `HttpResponseKind.make` — the
 * dispatcher pins the matched entity per request at `ResponseStart` and
 * assumes it stays put — extended to copy the optional `followUpSteps`.
 */
const make = <TParsed>(
  definition: CollectorHttpResponseKind<TParsed>
): CollectorHttpResponseKind<TParsed> =>
  deepFreeze({
    name: definition.name,
    tryRecognize: definition.tryRecognize,
    parse: definition.parse,
    // `followUpSteps` is declared as a method (for covariance — see the interface
    // note), so copying the reference trips `unbound-method`; it is a pure,
    // `this`-free function, so the concern (unintended `this` scoping) can't apply.
    // oxlint-disable-next-line typescript-eslint/unbound-method -- pure, this-free method; the copy is safe
    followUpSteps: definition.followUpSteps,
  })

export { make }
export type { CollectorHttpResponseKind }
