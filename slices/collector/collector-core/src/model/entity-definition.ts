import type { Effect, ParseResult } from 'effect'
import { deepFreeze } from 'kitchen-sink/freeze'
import type * as Link from './link.ts'
import type { RemoteResponse } from './response.ts'

/**
 * Outcome of a successful parse — the resources to commit downstream
 * plus any follow-up `Link`s the host should open next (for example,
 * a `Patient` parse may return a search-results link for related
 * `Observation`s).
 */
interface Parsed<TResources> {
  readonly resources: readonly TResources[]
  readonly links: readonly Link.Any[]
}

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
 * namespace: `import { EntityDefinition } from 'collector-core/model'`
 * → `EntityDefinition.EntityDefinition<T>` for the type,
 * `EntityDefinition.make({...})` for the constructor.
 *
 * - `name`: stable identifier, useful for logging and the entity
 *   constructor's `static name` slot in the old shape.
 * - `isFoundAt`: URL-match predicate;
 *   `CollectorBridgeMessageHandler.ResponseStart` consults this to
 *   decide whether to track an in-flight response (and cancels the
 *   sniffer-side request via `sendMessage` when no entity matches).
 * - `parse`: `Effect`-returning decode from `RemoteResponse` to
 *   `Parsed`, with `ParseError` in the error channel. Returning an
 *   `Effect` (rather than an `Either`) lets entities log progress
 *   (`Effect.logInfo` for dropped bundle entries, for example) and
 *   stays compatible with future requirements that may need
 *   Effect-typed dependencies (clock, randomness, …).
 */
interface EntityDefinition<TResources> {
  readonly name: string
  readonly isFoundAt: (url: string) => boolean
  readonly parse: (
    response: RemoteResponse
  ) => Effect.Effect<Parsed<TResources>, ParseResult.ParseError>
}

/**
 * Shallow-clone + deep-freeze the supplied definition so callers
 * cannot mutate `entityDefinitions` (via `Remote.make`) after
 * construction — the dispatcher pins the matched entity per request
 * at `ResponseStart` and assumes it stays put. The clone copies the
 * three known fields (`name`, `isFoundAt`, `parse`) so an extra
 * unexpected property on the caller's object is silently dropped.
 */
const make = <TResources>(
  definition: EntityDefinition<TResources>
): EntityDefinition<TResources> =>
  deepFreeze({
    name: definition.name,
    isFoundAt: definition.isFoundAt,
    parse: definition.parse,
  })

export { make }
export type { EntityDefinition, Parsed }
