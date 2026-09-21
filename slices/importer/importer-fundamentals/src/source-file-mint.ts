/**
 * The minting half every decode function shares: resolving a picked file to
 * the source-file reference its resources are stamped with, and listing the
 * minted archives as their own reviewable section.
 *
 * @remarks
 * Split out of `per-file-decode-function.ts` when a second decode function
 * appeared: nothing here is per-file or per-group. What differs between the
 * constructors — how many files one decode sees, how their sections and notes
 * are combined, what a rejecting file does to its neighbours — is not here.
 *
 * Like `per-file-decode-function.ts`, this calls the codec unbound, so the
 * decode a constructor builds still carries the `SourceFileCodec.FormatContext`
 * requirement for `FileImporter.make` to discharge in one place.
 *
 * @packageDocumentation
 */

import { Effect, type ParseResult } from 'effect'
import type { DocumentReference } from 'fhir-r4/resources'

import type * as DecodedFile from './decoded-file.ts'
import type * as PickedFile from './picked-file.ts'
import * as SourceFileCodec from './source-file-codec.ts'
import * as SourceFile from './source-file.ts'

/** The section title one picked file's minted archive is reviewed under. */
const SOURCE_FILE_SECTION_TITLE = 'Source file'

/** The section title several archives read as one unit are reviewed under. */
const SOURCE_FILES_SECTION_TITLE = 'Source files'

/** The review key of a minted source-file row, stable across a settings re-decode. */
const key = (fileName: string): string => `source-file/${fileName}`

/**
 * What one picked file resolved to before its decode ran.
 *
 * @remarks
 * A `local` pick's source file is minted here but built *after* the decode, so
 * it can be filed under the subject and the related resources the decode's own
 * output names. {@link encode} is that deferred build — `undefined` for a
 * `server` pick, whose resource is already stored.
 */
interface Resolved {
  /** The pick this resolved, so a caller can key and title its row. */
  readonly file: PickedFile.Type
  /** The reference every resource read out of this file is stamped with. */
  readonly reference: SourceFile.Reference
  /** Build the archive to store, once the decode has named how to file it. */
  readonly encode:
    | ((
        filing: SourceFileCodec.Filing
      ) => Effect.Effect<
        DocumentReference.Type,
        ParseResult.ParseError,
        SourceFileCodec.FormatContext
      >)
    | undefined
}

/**
 * Resolve one picked file to the source file its resources name: the stored
 * one for a `server` pick, a freshly minted one for a `local` pick.
 *
 * @param file - The picked file
 * @returns Its reference, and — for a local pick — the deferred encode of the
 *   archive to store
 */
const resolve = (
  file: PickedFile.Type
): Effect.Effect<Resolved, ParseResult.ParseError, SourceFileCodec.FormatContext> => {
  if (file.source._tag === 'server') {
    return Effect.succeed({ file, reference: file.source.reference, encode: undefined })
  }
  return SourceFileCodec.tryFromNamedBytes(file).pipe(
    Effect.map((sourceFile) => ({
      file,
      reference: SourceFile.makeReference(sourceFile.id),
      encode: (filing: SourceFileCodec.Filing) => SourceFileCodec.encode(sourceFile, filing),
    }))
  )
}

/**
 * Put the minted archives in front of the sections decoded out of them.
 *
 * @remarks
 * Their own section rather than rows appended to one of the format's, so the
 * reviewer sees what is about to be stored before what was read out of it. A
 * unit that minted nothing — every file of it a `server` pick — keeps its
 * sections untouched rather than growing an empty heading.
 *
 * @param decoded - The unit's decode, already key-namespaced and stamped
 * @param rows - The minted source-file rows, in pick order
 * @returns The decode with the source-file section prepended
 */
const prependSection = (
  decoded: DecodedFile.DecodedFile,
  rows: readonly DecodedFile.Resource[]
): DecodedFile.DecodedFile => {
  if (rows.length === 0) return decoded
  const title = rows.length === 1 ? SOURCE_FILE_SECTION_TITLE : SOURCE_FILES_SECTION_TITLE
  return { ...decoded, sections: [{ title, resources: rows }, ...decoded.sections] }
}

export { SOURCE_FILE_SECTION_TITLE, SOURCE_FILES_SECTION_TITLE, key, prependSection, resolve }
export type { Resolved }
