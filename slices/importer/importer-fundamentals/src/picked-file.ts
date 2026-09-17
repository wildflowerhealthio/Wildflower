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

import * as SourceFile from './source-file.ts'

/**
 * Where a {@link PickedFile} came from: a `local` file the device holds, or a
 * `server` file already stored as a `DocumentReference` on the FHIR server.
 *
 * @remarks
 * Named `Source` rather than `PickedFileSource` because this module is
 * consumed as the `PickedFileSource` namespace — `PickedFileSource.Source`
 * and `PickedFileSource.local` then read as one vocabulary, where a type and
 * a namespace sharing the name `PickedFileSource` meant two different things
 * at the same import site.
 */
type Source =
  | { readonly _tag: 'local' }
  | { readonly _tag: 'server'; readonly reference: SourceFile.Reference }

const local: Source = { _tag: 'local' }

const server = (id: string): Source => ({
  _tag: 'server',
  reference: SourceFile.makeReference(id),
})

/** A file chosen from one of the picker's sources, ready to hand on. */
interface PickedFile {
  /** The file's name, for display and for an eventual upload's title. */
  readonly fileName: string
  /** The file's raw bytes, exactly as they were read. */
  readonly bytes: Uint8Array
  /** Which source produced this pick. */
  readonly source: Source
}

export { local, server }
export type { PickedFile, Source }
