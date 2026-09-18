/**
 * The one value every picker source converges on and every format's `decode`
 * receives: a file's name, its raw bytes, and where it came from.
 *
 * @remarks
 * Bytes rather than text so the picker stays format-blind: a HAR decodes
 * UTF-8 JSON, a PDF decodes binary. The provenance rides along because a
 * format's decode owns the source-file `DocumentReference` — see
 * {@link Source}, which this module re-exports from `picked-file-source.ts`.
 *
 * @packageDocumentation
 */

import * as Source from './picked-file-source.ts'

/**
 * A named blob of bytes — the part of a {@link Type | picked file} that a step
 * which does not care where the file came from needs.
 *
 * @remarks
 * Named so the source-file mint, the read of a stored source file's contents,
 * and `FormatDetector.claiming` all spell one shape instead of three
 * structural copies of it.
 */
interface NamedBytes {
  /** The file's name, for display and for an eventual upload's title. */
  readonly fileName: string
  /** The file's raw bytes, exactly as they were read. */
  readonly bytes: Uint8Array
}

/** A file chosen from one of the picker's sources, ready to hand on. */
interface Type extends NamedBytes {
  /** Which source produced this pick. */
  readonly source: Source.Type
}

export { Source }
export type { NamedBytes, Type }
