import type { Effect, ParseResult } from 'effect'
import { deepFreeze } from 'kitchen-sink'
import type { RemoteResponse } from './response.ts'
import type * as Step from './step.ts'

/**
 * Stateless, struct-shaped *definition* of an entity — not an entity
 * in and of itself, just a recipe `CollectorBridgeMessageHandler` uses to
 * recognize matching responses and decode them. A concrete entity
 * (e.g. `PatientEntity`) is a value built by {@link make}, not an
 * instance; its `parse` closes over whatever schemas / decoders it
 * needs and takes the in-flight {@link RemoteResponse} each call.
 * Passing the full response (not a pre-extracted slice of fields)
 * keeps the data flow visible: an entity can read `response.text()`,
 * `response.headers`, and `response.url` on demand without the
 * dispatcher having to know in advance which it'll need.
 *
 * Replaces the previous `abstract class RemoteEntity<T>` /
 * `RemoteEntityConstructor<T>` pair; the inheritance chain became a
 * manual function chain (each concrete entity calls {@link make} once
 * and exports the result). Import callers use the file as a
 * namespace: `import { EntityDefinition } from 'collector-fundamentals/model'`
 * → `EntityDefinition.EntityDefinition<T>` for the type,
 * `EntityDefinition.make({...})` for the constructor.
 *
 * - `name`: stable identifier, useful for logging and the entity
 *   constructor's `static name` slot in the old shape.
 * - `isFoundAt`: URL-match predicate;
 *   `CollectorBridgeMessageHandler.ResponseStart` consults this to
 *   decide whether to track an in-flight response (and cancels the
 *   sniffer-side request via `sendMessage` when no entity matches).
 * - `parse`: `Effect`-returning decode from `RemoteResponse` to the
 *   resource array, with `ParseError` in the error channel. Returning
 *   an `Effect` (rather than an `Either`) lets entities log progress
 *   (`Effect.logInfo` for dropped bundle entries, for example) and
 *   stays compatible with future requirements that may need
 *   Effect-typed dependencies (clock, randomness, …). `parse` stays a
 *   *pure decode*: it never emits navigation.
 * - `followUpSteps` (optional): the declared, statically-visible seam for
 *   reactive crawling. Every time this entity's `parse` succeeds, the
 *   handler calls it with the just-parsed resources and the settled
 *   {@link RemoteResponse}, and appends whatever `Step`s it returns to the
 *   back of the automatic-navigation queue (breadth-first). It is **pure and
 *   synchronous** — a plain `resources → steps` function, not an `Effect` — so
 *   generation is visible at the definition site and its invocation is owned by
 *   the handler, not hidden inside `parse`. `response` is passed alongside the
 *   parsed resources so a generator can resolve relative links against
 *   `response.url` (e.g. open every entry linked from a list/table). Run-wide
 *   dedup of generated `Open`s by URI and a `ScrapingPlan.maxGeneratedSteps`
 *   cap (enforced by the handler, not here) keep the naturally-recursive
 *   fan-out terminating. Omit it for a leaf entity that never spawns work.
 *
 *   Generation is a separate, named field rather than a `parse` side-channel, so
 *   `parse` stays a pure decode with no hidden control flow, and the handler —
 *   not the decode — owns when generation runs.
 */
interface EntityDefinition<TResources> {
  readonly name: string
  readonly isFoundAt: (url: string) => boolean
  readonly parse: (
    response: RemoteResponse
  ) => Effect.Effect<readonly TResources[], ParseResult.ParseError>
  // Declared as a *method* signature, not a `readonly` arrow property, on
  // purpose: `resources` puts `TResources` in a parameter (contravariant)
  // position, which would make `EntityDefinition` — and thus `ScrapingPlan` —
  // invariant in `TResources`, breaking the `ScrapingPlan<Resources>` →
  // `ScrapingPlan<unknown>` widening the sealed-`Resources` existential relies
  // on. Method parameters are checked bivariantly, so this keeps the type
  // covariant (as it was when `parse` was the only member) while still typing
  // the generator precisely.
  followUpSteps?(resources: readonly TResources[], response: RemoteResponse): readonly Step.Step[]
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
const make = <TResources>(definition: EntityDefinition<TResources>): EntityDefinition<TResources> =>
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
export type { EntityDefinition }
