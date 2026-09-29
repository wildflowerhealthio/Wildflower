import { Data, Effect, Schema } from 'effect'
import { type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { sha256Base64 } from 'importer-fundamentals'
import { unknownErrorToString } from 'kitchen-sink'
import { DataSet, DataSetLayout, DataSetManifest } from 'synthetic-data-core'

/**
 * Reading a published data set off its static host: `index.json`, then the
 * picked people's resource files, each source file with its static file
 * carried inline again.
 *
 * @remarks
 * Every path read comes from the manifest, whose schema has already checked
 * it against the layout's grammar (`DataSetLayout.ResourcePathSchema`,
 * `StaticFilePathSchema`), so a read never leaves the data set's root.
 *
 * A source file is laid out with a relative `url` to its HAR or DICOM file
 * instead of the `data` its import stored. The reader fetches that file and
 * puts it back as `data` (`DataSetLayout.withStaticFileData`), so the
 * `DocumentReference` a load writes is the one the importer wrote: the
 * importer's server source-file list reads a file back from its `data`, and
 * a relative `url` would name nothing on the FHIR server. The bytes are
 * checked against the attachment's `size` and `hash` before they are
 * inlined, so a stale or wrong file is a failed read, not a source file whose
 * hash lies.
 */

/** How the reader fetches a file: `globalThis.fetch`, or a stub in a test. */
type Fetch = (url: string) => Promise<Response>

/** A file of the data set that could not be read, and why. */
class DataSetReadFailed extends Data.TaggedError('DataSetReadFailed')<{
  /** The file's path from the data set's root. */
  readonly path: string
  /** A sentence naming the file and what went wrong, for the reader. */
  readonly message: string
}> {}

/** How many files are fetched at once. */
const READ_CONCURRENCY = 8

const readFailed = (path: string, why: string): DataSetReadFailed =>
  new DataSetReadFailed({ path, message: `${path}: ${why}` })

/** The response for `path`, which must be a success. */
const fetchOk = (
  root: URL,
  path: string,
  fetchUrl: Fetch
): Effect.Effect<Response, DataSetReadFailed> =>
  Effect.tryPromise({
    try: () => fetchUrl(new URL(path, root).href),
    catch: (cause) => readFailed(path, `it could not be fetched (${unknownErrorToString(cause)}).`),
  }).pipe(
    Effect.filterOrFail(
      (response) => response.ok,
      (response) =>
        readFailed(path, `the host answered ${`${response.status} ${response.statusText}`.trim()}.`)
    )
  )

/** The JSON the file at `path` holds. */
const readJson = (
  root: URL,
  path: string,
  fetchUrl: Fetch
): Effect.Effect<unknown, DataSetReadFailed> =>
  fetchOk(root, path, fetchUrl).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: (): Promise<unknown> => response.json(),
        catch: (cause) => readFailed(path, `it is not JSON (${unknownErrorToString(cause)}).`),
      })
    )
  )

/** The bytes of the file at `path`. */
const readBytes = (
  root: URL,
  path: string,
  fetchUrl: Fetch
): Effect.Effect<Uint8Array<ArrayBuffer>, DataSetReadFailed> =>
  fetchOk(root, path, fetchUrl).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: async () => new Uint8Array(await response.arrayBuffer()),
        catch: (cause) =>
          readFailed(path, `its body could not be read (${unknownErrorToString(cause)}).`),
      })
    )
  )

/**
 * The data set's manifest, `index.json`.
 *
 * @param root - The data set's root (`dataSetRootOf`)
 * @param fetchUrl - How files are fetched
 * @returns The decoded manifest, or a {@link DataSetReadFailed} when it cannot
 *   be fetched or is not a manifest this app reads
 */
const readManifest = (
  root: URL,
  fetchUrl: Fetch
): Effect.Effect<DataSetManifest.Type, DataSetReadFailed> =>
  readJson(root, DataSet.MANIFEST_PATH, fetchUrl).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknown(DataSetManifest.Schema)(json).pipe(
        Effect.mapError((error) =>
          readFailed(DataSet.MANIFEST_PATH, `it is not a data set manifest. ${error.message}`)
        )
      )
    )
  )

/**
 * A laid-out source file's JSON with its static file inline again, once the
 * bytes fetched are the file its attachment describes.
 */
const withStaticFileRead = (
  root: URL,
  { documentReferenceJson, staticFilePath }: DataSetLayout.StaticFileLink,
  fetchUrl: Fetch
): Effect.Effect<DataSetLayout.DocumentReferenceJson, DataSetReadFailed> =>
  Effect.gen(function* () {
    const bytes = yield* readBytes(root, staticFilePath, fetchUrl)
    const attachment = documentReferenceJson.content[0]?.attachment
    if (attachment?.size !== bytes.length) {
      return yield* readFailed(
        staticFilePath,
        `it is ${bytes.length} bytes, and its source file says ${String(attachment?.size)}.`
      )
    }
    const hash = yield* sha256Base64(bytes).pipe(
      Effect.mapError((error) => readFailed(staticFilePath, error.reason))
    )
    if (attachment.hash !== hash) {
      return yield* readFailed(staticFilePath, 'its SHA-256 is not the one its source file states.')
    }
    return DataSetLayout.withStaticFileData(documentReferenceJson, bytes)
  })

/** The resource the file at `path` holds, which must be the one its path names. */
const readResource = (
  root: URL,
  path: string,
  fetchUrl: Fetch
): Effect.Effect<FhirResource, DataSetReadFailed> =>
  Effect.gen(function* () {
    const json = yield* readJson(root, path, fetchUrl).pipe(
      Effect.flatMap((unknownJson) =>
        Schema.decodeUnknown(DataSetLayout.ResourceJsonSchema)(unknownJson).pipe(
          Effect.mapError((error) =>
            readFailed(path, `it is not a FHIR R4 resource. ${error.message}`)
          )
        )
      )
    )
    const link = DataSetLayout.staticFileLinkOf(json)
    const inlineJson = link === undefined ? json : yield* withStaticFileRead(root, link, fetchUrl)
    const resource = yield* Schema.decode(FhirResourceSchema)(inlineJson).pipe(
      Effect.mapError((error) => readFailed(path, `it is not a FHIR R4 resource. ${error.message}`))
    )
    const heldPath =
      resource.id === null
        ? undefined
        : DataSetLayout.resourcePathOf(resource.resourceType, resource.id)
    if (heldPath !== path) {
      return yield* readFailed(
        path,
        `it holds ${resource.resourceType}/${resource.id ?? '<no id>'}, not the resource its path names.`
      )
    }
    return resource
  })

/**
 * The resources in the files at `paths`, fetched a few at a time.
 *
 * @param root - The data set's root
 * @param paths - Resource file paths from the manifest
 * @param fetchUrl - How files are fetched
 * @param onFileRead - Called once as each file is read, for progress
 * @returns The resources, in the order of `paths`; the first
 *   {@link DataSetReadFailed} when any file cannot be read, so a load never
 *   writes part of a person's records
 */
const readResources = (
  root: URL,
  paths: readonly string[],
  fetchUrl: Fetch,
  onFileRead: () => void
): Effect.Effect<readonly FhirResource[], DataSetReadFailed> =>
  Effect.forEach(
    paths,
    (path) => readResource(root, path, fetchUrl).pipe(Effect.tap(() => Effect.sync(onFileRead))),
    { concurrency: READ_CONCURRENCY }
  )

export { DataSetReadFailed, READ_CONCURRENCY, readManifest, readResources }
export type { Fetch }
