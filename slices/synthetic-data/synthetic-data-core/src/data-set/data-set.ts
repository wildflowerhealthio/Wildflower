import { type DateTime, Either, type ParseResult, Schema } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'

import * as DataSetLayout from './data-set-layout.ts'
import * as DataSetManifest from './data-set-manifest.ts'

/**
 * A whole data set as the files to write: every person's resources and the
 * files they were imported from, laid out (`DataSetLayout`), and `index.json`
 * listing them (`DataSetManifest`) — so the step that publishes it only
 * writes each file at its path.
 */

/** Where the manifest sits: the data set's root. */
const MANIFEST_PATH = 'index.json'

/** A person and every resource the imports of their records made. */
interface PersonRecords {
  readonly person: DataSetManifest.Person
  /**
   * Importer output, in the order each import wrote it, including the
   * source-file `DocumentReference` every `meta.source` among them names. A
   * resource two people share (a family account's HAR) is listed under each.
   */
  readonly resources: readonly FhirResource[]
}

/** One file of the data set: its path from the root, and its contents. */
interface File {
  readonly path: string
  /** Text (JSON, UTF-8) or the bytes of a static file, exactly as they are to be written. */
  readonly contents: string | Uint8Array
}

/** `value` as a file holds JSON: two-space indented, with a trailing newline. */
const jsonTextOf = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

const encodeManifest = Schema.encodeEither(DataSetManifest.Schema)

/**
 * Every file of a data set, in path order: one per resource, one per static
 * file, and `index.json`.
 *
 * @param asOf - The as-of instant the records were rendered for
 * @param wildflowerCommit - The Wildflower commit generating it, which the
 *   manifest records
 * @param people - Each person's records, in the order the manifest lists them
 * @returns The files, identical for identical inputs; a resource or static file
 *   two people share is written once. Fails as `DataSetLayout.layOut` does per
 *   person, with a `ConflictingFiles` when two people's files differ at one
 *   path, or with a `ParseError` when the manifest does not encode (two people
 *   under one key, a key or name it does not accept)
 */
const assemble = (
  asOf: DateTime.Utc,
  wildflowerCommit: string,
  people: readonly PersonRecords[]
): Either.Either<
  readonly File[],
  DataSetLayout.UnplaceableResource | DataSetLayout.ConflictingFiles | ParseResult.ParseError
> =>
  Either.gen(function* () {
    const peopleFiles = yield* Either.all(
      people.map(({ person, resources }) =>
        DataSetLayout.layOut(resources).pipe(Either.map((files) => ({ person, ...files })))
      )
    )
    const files = yield* DataSetLayout.merge(peopleFiles)
    const manifest = yield* encodeManifest(
      DataSetManifest.manifestOf(asOf, wildflowerCommit, peopleFiles)
    )
    const written: readonly File[] = [
      { path: MANIFEST_PATH, contents: jsonTextOf(manifest) },
      ...files.resources.map(({ path, json }) => ({ path, contents: jsonTextOf(json) })),
      ...files.staticFiles.map(({ path, bytes }) => ({ path, contents: bytes })),
    ]
    return written.toSorted(DataSetLayout.byPath)
  })

export { assemble, MANIFEST_PATH }
export type { File, PersonRecords }
