import { Data, type DateTime, Effect, Either, ParseResult, Schema } from 'effect'
import { type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { sha256Base64 } from 'importer-fundamentals'

import * as DataSetLayout from './data-set-layout.ts'
import * as DataSetManifest from './data-set-manifest.ts'

/**
 * A whole data set as its files: every person's resources and the files they
 * were imported from, laid out (`DataSetLayout`), and `index.json` listing
 * them (`DataSetManifest`) — so the step that publishes it only writes each
 * file at its path ({@link assemble}), and a reader only fetches each file
 * and reads back the resource the import made ({@link readManifest},
 * {@link readResource}).
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

/** A data set file that cannot be read back, and why. */
class UnreadableFile extends Data.TaggedError('UnreadableFile')<{
  /** The file's path from the data set's root. */
  readonly path: string
  readonly reason: string
}> {
  /** `<path>: <reason>`, the line a reader shows. */
  override get message(): string {
    return `${this.path}: ${this.reason}`
  }
}

/**
 * Where a reader gets a data set's files: each one by its path from the data
 * set's root, as text (`index.json`, a resource file) or as bytes (a static
 * file). A file that cannot be fetched fails as an {@link UnreadableFile}.
 */
interface FileSource {
  readonly text: (path: string) => Effect.Effect<string, UnreadableFile>
  readonly bytes: (path: string) => Effect.Effect<Uint8Array, UnreadableFile>
}

/** `error`'s issues, as one line a reader can show. */
const reasonOf = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`
    )
    .join('; ')

const decodeManifestText = Schema.decodeUnknown(Schema.parseJson(DataSetManifest.Schema))

/**
 * The data set's `index.json`, decoded: its people and the paths of their
 * files, every path already in the layout's grammar.
 */
const readManifest = (source: FileSource): Effect.Effect<DataSetManifest.Type, UnreadableFile> =>
  source.text(MANIFEST_PATH).pipe(
    Effect.flatMap(decodeManifestText),
    Effect.catchTag('ParseError', (error) =>
      Effect.fail(new UnreadableFile({ path: MANIFEST_PATH, reason: reasonOf(error) }))
    )
  )

const decodeResourceJsonText = Schema.decodeUnknownEither(
  Schema.parseJson(DataSetLayout.ResourceJsonSchema)
)

const decodeResource = Schema.decodeUnknownEither(FhirResourceSchema)

/**
 * A resource file's JSON, checked to hold the resource its path names — a
 * file at `fhir/Patient/a.json` holds `Patient/a` — so a data set cannot
 * write one resource under another's name.
 */
const resourceJsonOf = (
  path: string,
  text: string
): Either.Either<DataSetLayout.ResourceJson, UnreadableFile> =>
  decodeResourceJsonText(text).pipe(
    Either.mapLeft((error) => new UnreadableFile({ path, reason: reasonOf(error) })),
    Either.filterOrLeft(
      (json) =>
        json.id !== undefined && DataSetLayout.resourcePathOf(json.resourceType, json.id) === path,
      (json) =>
        new UnreadableFile({
          path,
          reason: `It holds ${json.resourceType}/${json.id ?? '<no id>'}, not the resource its path names.`,
        })
    )
  )

/**
 * A laid-out source file with its static file carried inline again, once the
 * bytes are checked to be the file its attachment describes: its `size` and
 * its `hash` (base64 SHA-256, as the importers write it).
 */
const withCheckedStaticFileData = (
  link: DataSetLayout.StaticFileLink,
  bytes: Uint8Array
): Effect.Effect<DataSetLayout.DocumentReferenceJson, UnreadableFile> =>
  Effect.gen(function* () {
    const unreadable = (reason: string): UnreadableFile =>
      new UnreadableFile({ path: link.staticFilePath, reason })
    const attachment = link.documentReferenceJson.content[0]?.attachment
    const size = attachment?.size
    const hash = attachment?.hash
    if (size !== bytes.length) {
      return yield* unreadable(
        `It is ${bytes.length} bytes; its DocumentReference says ${size ?? 'nothing'}.`
      )
    }
    const digest = yield* sha256Base64(new Uint8Array(bytes)).pipe(
      Effect.mapError((error) => unreadable(`Its SHA-256 cannot be computed: ${error.reason}`))
    )
    if (digest !== hash) {
      return yield* unreadable(
        `Its SHA-256 is ${digest}; its DocumentReference says ${hash ?? 'nothing'}.`
      )
    }
    return DataSetLayout.withStaticFileData(link.documentReferenceJson, bytes)
  })

/**
 * The resource a data set's file holds, as the import wrote it: a source
 * file's static file is fetched, checked and carried inline again, and the
 * whole decoded as `fhir-r4`'s `FhirResourceSchema`.
 *
 * @param source - Where the data set's files are fetched from
 * @param path - A resource file's path, as the manifest lists it
 * @returns The resource; an {@link UnreadableFile} for a file that cannot be
 *   fetched or decoded, that holds a resource other than the one its path
 *   names, or whose static file is not the one its attachment describes
 */
const readResource = (
  source: FileSource,
  path: string
): Effect.Effect<FhirResource, UnreadableFile> =>
  Effect.gen(function* () {
    const json = yield* resourceJsonOf(path, yield* source.text(path))
    const link = DataSetLayout.staticFileLinkOf(json)
    const readJson =
      link === undefined
        ? json
        : yield* withCheckedStaticFileData(link, yield* source.bytes(link.staticFilePath))
    return yield* decodeResource(readJson).pipe(
      Either.mapLeft((error) => new UnreadableFile({ path, reason: reasonOf(error) }))
    )
  })

export { assemble, MANIFEST_PATH, readManifest, readResource, UnreadableFile }
export type { File, FileSource, PersonRecords }
