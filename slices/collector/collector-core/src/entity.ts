import type { Either, ParseResult } from 'effect'
import type * as Link from './link.ts'

/**
 * Per-request payload handed to `parse`. The host strings the
 * `<WebView>` body + headers together; the response chunks are joined
 * upstream before they reach an entity.
 */
interface Init {
  readonly body: string
  readonly contentType: string
  readonly url: string
}

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
 * over whatever schemas / decoders it needs and takes the request's
 * {@link Init} each call.
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
 * - `parse`: pure function from `Init` to `Either<Parsed, ParseError>`.
 *   Errors are returned, not thrown; the host decides whether to log
 *   and continue or to abort the sync.
 */
interface Entity<TResources> {
  readonly name: string
  readonly isFoundAt: (url: string) => boolean
  readonly parse: (init: Init) => Either.Either<Parsed<TResources>, ParseResult.ParseError>
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
export type { Entity, Init, Parsed }
