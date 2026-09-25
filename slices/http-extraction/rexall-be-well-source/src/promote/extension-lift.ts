import { Option, pipe, Schema } from 'effect'

import { Extension } from 'fhir-r4/data-types'
import { Lift } from 'kitchen-sink'

/**
 * `kitchen-sink`'s {@link Lift} applied to FHIR extension lists: reading an
 * extension by url, and the lift-and-drop step every promotion is built from.
 *
 * @remarks
 * Carries no carebook knowledge; the traps behind lift-and-drop are in this
 * package's AGENTS.md under "Extension Promotion".
 */

/**
 * The **first** extension at `url`, decoded through `schema` — `None` when
 * there is no entry at `url` or the first one does not decode.
 *
 * @remarks
 * A second copy is never read in place of a first that fails to decode: the
 * dialect writes some urls twice, and a malformed first copy means the value
 * is unknown, not that the second one holds it.
 */
const atUrl = <A, I>(url: string, schema: Schema.Schema<A, I>): Lift.Lift<A, Extension.Type> => {
  const decode = Schema.decodeUnknownOption(schema)
  return pipe(
    Lift.first(Option.liftPredicate(Extension.hasUrl(url))),
    Lift.filterMap((extension) => decode(extension))
  )
}

/**
 * Anything carrying an `extension` list of `E`: a decoded resource, or a raw
 * `contained` Medication, whose list may be absent.
 */
interface Extended<E> {
  readonly extension?: readonly E[] | undefined
}

/**
 * A lift-and-drop step: read a value off `resource.extension` with `lift`,
 * and `land` it on the resource without the entry it came from — or, when it
 * does not land, leave the resource exactly as it was, entry included.
 *
 * @param lift - Reads the value off the resource's `extension`
 * @param land - Writes the value into its conventional slot on a resource
 * that no longer carries the entry, or returns `None` when the resource has
 * nowhere to hold it — the extension then stays, since a value nobody promoted
 * is never dropped
 * @returns A `(resource) => resource` step for a `pipe`
 */
const promoteExtension =
  <R extends Extended<E>, E, A>(
    lift: Lift.Lift<A, E>,
    land: (resourceWithoutEntry: R, value: A) => Option.Option<R>
  ) =>
  (resource: R): R =>
    pipe(
      lift(resource.extension ?? []),
      Option.flatMap(({ value, remaining }) => land({ ...resource, extension: remaining }, value)),
      Option.getOrElse(() => resource)
    )

export { atUrl, promoteExtension }
