// oxlint-disable import/group-exports
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

namespace Source {
  /**
   * Where a {@link PickedFile} came from: a `local` file the device holds, or a
   * `server` file already stored as a `DocumentReference` on the FHIR server.
   *
   * @remarks
   * Named `Source`, not `PickedFileSource`, because this module is consumed as
   * the `PickedFileSource` namespace: one name meaning both a namespace and a
   * type at the same import site is what that avoids.
   */
  export type Type =
    | { readonly _tag: 'local' }
    | { readonly _tag: 'server'; readonly reference: SourceFile.Reference }

  export const local: Type = { _tag: 'local' }

  export const server = (id: string): Type => ({
    _tag: 'server',
    reference: SourceFile.makeReference(id),
  })
}

/**
 * A named blob of bytes — the part of a {@link PickedFile} that a step which
 * does not care where the file came from needs.
 *
 * @remarks
 * Named so the source-file mint, the read of a stored source file's contents,
 * and `identify` all spell one shape instead of three structural copies of it.
 */
interface NamedBytes {
  /** The file's name, for display and for an eventual upload's title. */
  readonly fileName: string
  /** The file's raw bytes, exactly as they were read. */
  readonly bytes: Uint8Array
}

/** A file chosen from one of the picker's sources, ready to hand on. */
interface PickedFile extends NamedBytes {
  /** Which source produced this pick. */
  readonly source: Source.Type
}

export { Source }
export type { NamedBytes, PickedFile }
