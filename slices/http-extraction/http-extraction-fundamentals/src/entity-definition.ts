import type { Effect, ParseResult } from 'effect'
import { deepFreeze } from 'kitchen-sink'
import type { HttpResponse } from './http-response.ts'

/**
 * Stateless, struct-shaped *definition* of an entity — not an entity
 * in and of itself, just a recipe a routing loop uses to recognize
 * matching responses and decode them. A concrete entity
 * (e.g. `PatientEntity`) is a value built by {@link make}, not an
 * instance; its `parse` closes over whatever schemas / decoders it
 * needs and takes the {@link HttpResponse} each call. Passing
 * the full response (not a pre-extracted slice of fields) keeps the
 * data flow visible: an entity can read `response.text()`,
 * `response.headers`, and `response.url` on demand without the
 * dispatcher having to know in advance which it'll need.
 *
 * Import callers use the file as a namespace:
 * `import { EntityDefinition } from 'http-extraction-fundamentals'`
 * → `EntityDefinition.EntityDefinition<T>` for the type,
 * `EntityDefinition.make({...})` for the constructor.
 *
 * - `name`: stable identifier, useful for logging and reporting which
 *   entity claimed a response.
 * - `isFoundAt`: URL-match predicate; whichever loop walks the entity
 *   list — `Extraction.run` over an archive, or a live handler over
 *   sniffed traffic — consults this to route each response, first
 *   match wins.
 * - `parse`: `Effect`-returning decode from {@link HttpResponse}
 *   to the resource array, with `ParseError` in the error channel.
 *   Returning an `Effect` (rather than an `Either`) lets entities log
 *   progress (`Effect.logInfo` for dropped bundle entries, for
 *   example) and stays compatible with future requirements that may
 *   need Effect-typed dependencies (clock, randomness, …). `parse`
 *   stays a *pure decode*: it never emits navigation.
 */
interface EntityDefinition<TResources> {
  readonly name: string
  readonly isFoundAt: (url: string) => boolean
  readonly parse: (
    response: HttpResponse
  ) => Effect.Effect<readonly TResources[], ParseResult.ParseError>
}

/**
 * Shallow-clone + deep-freeze the supplied definition so callers
 * cannot mutate an entity list after construction — a routing loop
 * pins the matched entity per response and assumes it stays put. The
 * clone copies the known fields (`name`, `isFoundAt`, `parse`) so an
 * extra unexpected property on the caller's object is silently
 * dropped.
 */
const make = <TResources>(definition: EntityDefinition<TResources>): EntityDefinition<TResources> =>
  deepFreeze({
    name: definition.name,
    isFoundAt: definition.isFoundAt,
    parse: definition.parse,
  })

export { make }
export type { EntityDefinition }
