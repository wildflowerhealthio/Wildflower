import { Array as Arr, Option, pipe, Schema } from 'effect'

import type { Extension } from 'fhir-r4/data-types'

/**
 * The lift-and-drop machinery every promotion step is built from: read a value
 * off an extension list, and — only once it has landed — drop **exactly the
 * entry it was read from**, never every entry that shares its url.
 *
 * Carries no carebook knowledge; the traps behind the rule are in this
 * package's AGENTS.md under "Extension Promotion".
 */

/**
 * A value read off an extension list, together with the list as it is once
 * that value's entry is gone.
 *
 * @typeParam A - The decoded value
 * @typeParam E - The list's entry type: a decoded `Extension`, or a raw
 * `contained` entry
 */
interface Lifted<A, E = Extension.Type> {
  /** The value the entry carried, decoded. */
  readonly value: A
  /** The list with exactly that one entry removed — every other copy kept. */
  readonly remaining: readonly E[]
}

/**
 * Read the **first** extension at `url` through `schema`.
 *
 * @returns The decoded value and the list without that entry — or `None` when
 * there is no entry at `url` or the first one does not decode. A second copy is
 * never consulted: the dialect writes some urls twice, and only the first is
 * read.
 */
const liftExtension =
  <A, I>(url: string, schema: Schema.Schema<A, I>) =>
  (extensions: readonly Extension.Type[]): Option.Option<Lifted<A>> => {
    const decode = Schema.decodeUnknownOption(schema)
    return pipe(
      Arr.findFirst(extensions, (extension, index) =>
        extension.url === url ? Option.some({ extension, index }) : Option.none()
      ),
      Option.flatMap(({ extension, index }) =>
        Option.map(decode(extension), (value) => ({
          value,
          remaining: Arr.remove(extensions, index),
        }))
      )
    )
  }

/**
 * Read the first **raw** entry that decodes through `schema` — for a
 * `contained` Medication, whose extensions are unvalidated wire JSON and are
 * each decoded on their own.
 */
const liftRawExtension =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (entries: readonly unknown[]): Option.Option<Lifted<A, unknown>> => {
    const decode = Schema.decodeUnknownOption(schema)
    return pipe(
      Arr.findFirst(entries, (entry, index) =>
        Option.map(decode(entry), (value) => ({ value, index }))
      ),
      Option.map(({ value, index }) => ({ value, remaining: Arr.remove(entries, index) }))
    )
  }

/** A resource carrying an `extension` list. */
interface Extended {
  readonly extension: readonly Extension.Type[]
}

/**
 * A lift-and-drop step: read a value off `resource.extension` with `lift`,
 * `land` it, and — only if it landed — drop the entry it came from.
 *
 * @param lift - Reads the value, and the list as it is without the entries
 * the value came from
 * @param land - Writes the value into its conventional slot, or `None` when
 * the resource has no slot to hold it (the extension then stays)
 * @returns A `(resource) => resource` step for a `pipe`
 */
const promoteExtension =
  <R extends Extended, A>(
    lift: (extensions: readonly Extension.Type[]) => Option.Option<Lifted<A>>,
    land: (resource: R, value: A) => Option.Option<R>
  ) =>
  (resource: R): R =>
    pipe(
      lift(resource.extension),
      Option.flatMap(({ value, remaining }) =>
        Option.map(land(resource, value), (landed) => ({ ...landed, extension: remaining }))
      ),
      Option.getOrElse(() => resource)
    )

export type { Lifted }
export { liftExtension, liftRawExtension, promoteExtension }
