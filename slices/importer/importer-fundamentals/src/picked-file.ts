/**
 * The one value every picker source converges on and every format's `decode`
 * receives: a file's name, its raw bytes, and where it came from.
 *
 * @remarks
 * Bytes rather than text so the picker stays format-blind: a HAR decodes
 * UTF-8 JSON, a PDF decodes binary. The provenance rides along because a
 * format's decode owns the source-file `DocumentReference`: for a `local`
 * pick it mints one (and stamps every extracted resource's `meta.source`
 * with it), and for a `server` pick — a source file already on the device's
 * FHIR server — it mints nothing and stamps the existing `reference`.
 *
 * @packageDocumentation
 */

/**
 * Where a {@link PickedFile} came from.
 *
 * @remarks
 * A `local` pick's bytes are what the confirm uploads, as the source-file
 * `DocumentReference` the format's decode mints. A `server` pick's `reference`
 * is the `DocumentReference/<id>` its extracted resources stamp onto
 * `meta.source` — the source file is already on the device, so nothing new
 * is uploaded.
 */
type PickedFileSource =
  | { readonly _tag: 'local' }
  | { readonly _tag: 'server'; readonly reference: string }

/** A file chosen from one of the picker's sources, ready to hand on. */
interface PickedFile {
  /** The file's name, for display and for an eventual upload's title. */
  readonly fileName: string
  /** The file's raw bytes, exactly as they were read. */
  readonly bytes: Uint8Array
  /** Which source produced this pick. */
  readonly source: PickedFileSource
}

/** A `local` source — a file the device holds and the server has never seen. */
const LOCAL_SOURCE: PickedFileSource = { _tag: 'local' }

/** The resource type every format's source file is stored as. */
const SOURCE_FILE_RESOURCE_TYPE = 'DocumentReference'

/**
 * The `DocumentReference/<id>` reference for an uploaded source file by
 * logical id, format-blind.
 *
 * @param id - The source-file `DocumentReference`'s logical id
 * @returns The literal FHIR reference string, `DocumentReference/<id>`
 *
 * @remarks
 * Spelled in one place so the `server` source, the `meta.source` stamp a
 * format's decode writes for a local source file, and {@link sourceFileIdOf}
 * all agree on the form. Every format's source-file resource type is
 * `DocumentReference`, so the shape is one string regardless of the format.
 */
const sourceFileReference = (id: string): string => `${SOURCE_FILE_RESOURCE_TYPE}/${id}`

/**
 * The logical id a {@link sourceFileReference} names — the inverse of that
 * function, so a `server` pick's decode can recover the id its resources
 * link to without the shell handing it over separately.
 *
 * @param reference - A `DocumentReference/<id>` reference string
 * @returns The `<id>` part, or `undefined` when the string is not a
 *   `DocumentReference` reference
 */
const sourceFileIdOf = (reference: string): string | undefined => {
  const prefix = `${SOURCE_FILE_RESOURCE_TYPE}/`
  if (!reference.startsWith(prefix)) return undefined
  const id = reference.slice(prefix.length)
  return id.length === 0 ? undefined : id
}

/**
 * The `server` {@link PickedFileSource} for a server-held source file by id.
 *
 * @param id - The source-file `DocumentReference`'s logical id
 * @returns A `server` source carrying its {@link sourceFileReference}
 */
const serverSource = (id: string): PickedFileSource => ({
  _tag: 'server',
  reference: sourceFileReference(id),
})

export {
  LOCAL_SOURCE,
  type PickedFile,
  type PickedFileSource,
  serverSource,
  sourceFileIdOf,
  sourceFileReference,
}
