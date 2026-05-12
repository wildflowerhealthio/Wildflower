import type { Either, ParseResult } from 'effect'
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
 * Stateless, struct-shaped entity definition. A concrete entity (e.g.
 * `PatientEntity`) is a value, not an instance — its `parse` closes
 * over whatever schemas / decoders it needs and takes the in-flight
 * {@link RemoteResponse} each call. Passing the full response (not a
 * pre-extracted slice of fields) keeps the data flow visible: an
 * entity can read `response.text()`, `response.headers`, and
 * `response.url` on demand without the dispatcher having to know in
 * advance which it'll need.
 *
 * Replaces the previous `abstract class RemoteEntity<T>` /
 * `RemoteEntityConstructor<T>` pair; the inheritance chain became a
 * manual function chain (each concrete entity calls {@link make} once
 * and exports the result). Import callers use the file as a
 * namespace: `import * as Entity from 'collector-core/entity'`.
 *
 * - `name`: stable identifier, useful for logging and the entity
 *   constructor's `static name` slot in the old shape.
 * - `isFoundAt`: URL-match predicate; `Remote.shouldKeepResponse`
 *   consults this to decide whether to track an in-flight response.
 * - `parse`: pure function from `RemoteResponse` to
 *   `Either<Parsed, ParseError>`. Errors are returned, not thrown;
 *   the host decides whether to log and continue or to abort the sync.
 */
interface Entity<TResources> {
  readonly name: string
  readonly isFoundAt: (url: string) => boolean
  readonly parse: (
    response: RemoteResponse
  ) => Either.Either<Parsed<TResources>, ParseResult.ParseError>
}

/**
 * Identity factory — defining an entity is a struct literal, but
 * routing through `make` matches the convention used elsewhere
 * (`Bridge.make`, `Remote.make`, ...) and gives a single place to
 * add behavior (validation, default fields, ...) if the shape ever
 * evolves.
 */
const make = <TResources>(entity: Entity<TResources>): Entity<TResources> => entity

export { make }
export type { Entity, Parsed }
