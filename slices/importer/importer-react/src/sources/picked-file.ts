/**
 * The one value every picker source converges on: a file's name, its raw
 * bytes, and where it came from.
 *
 * @remarks
 * Bytes rather than text so the picker stays format-blind: a HAR decodes
 * UTF-8 JSON, a PDF decodes binary. Every downstream step — format
 * identification, `decode`, and the source-file upload — reads bytes. The
 * three source variants stay distinguishable through {@link PickedFileSource}:
 * a `local` pick is a file that never touched the server (the importer
 * uploads its bytes when the user confirms), and a `server` pick is a
 * `DocumentReference` already on the device whose `reference` is stamped onto
 * `meta.source` without a fresh upload.
 *
 * @packageDocumentation
 */

/**
 * Where a {@link PickedFile} came from.
 *
 * @remarks
 * A `local` pick's bytes are what the shell uploads at confirm. A `server`
 * pick's `reference` is the `DocumentReference/<id>` a later step stamps onto
 * every resource's `meta.source` — the source file is already on the device,
 * so nothing new is uploaded.
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

/**
 * The `DocumentReference/<id>` reference for an uploaded source file by
 * logical id, format-blind.
 *
 * @param id - The source-file `DocumentReference`'s logical id
 * @returns The literal FHIR reference string, `DocumentReference/<id>`
 *
 * @remarks
 * Spelled in one place so the `server` source, the `meta.source` stamp a
 * confirm writes for a freshly-uploaded local source file, and any consumer
 * that resolves the reference back to an id all agree on the form. A
 * `server` pick already carries this reference; a `local` pick has none
 * until its bytes are uploaded, at which point the confirm step mints the
 * source file's id and turns it into a reference the same way here. Every
 * format's source-file resource type is `DocumentReference`, so the shape
 * is one string regardless of the file format.
 */
const sourceFileReference = (id: string): string => `DocumentReference/${id}`

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

export { sourceFileReference, LOCAL_SOURCE, type PickedFile, type PickedFileSource, serverSource }
