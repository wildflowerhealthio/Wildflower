/**
 * The source-file vocabulary every format binding shares: the `Type` a
 * format's `decode` mints or resolves, the `Reference` —
 * `DocumentReference/<id>` — that a `DecodeOne` receives and a stamped
 * resource's `meta.source` points at, the `Subject` a minted source file may be
 * filed under, and the `SECTION_TITLE` / `key` the review prepends a minted row
 * under.
 *
 * @remarks
 * `Reference` is the single currency for "which source file": a `server` pick
 * already carries one, a `local` pick's mint produces an id `makeReference`
 * wraps, and `idFromReference` is for the one format (DICOM) that needs the
 * bare id to build a resource link out of.
 *
 * @packageDocumentation
 */

import type { DateTime, Effect, ParseResult } from 'effect'

import type * as DecodedFile from './decoded-file.ts'
import type { PickedFile } from './picked-file.ts'

// ─── Source File ────────────────────────────────────────────────────────────

/** One uploaded source file, decoded: its id, name, upload instant, and bytes. */
interface Type {
  readonly id: string
  readonly fileName: string
  readonly uploadedAt: DateTime.Utc
  readonly bytes: Uint8Array
}

// ─── Reference ──────────────────────────────────────────────────────────────

const REFERENCE_PREFIX = 'DocumentReference/'

/**
 * A typed FHIR reference to a source file's `DocumentReference`, carrying the
 * invariant that the string is `DocumentReference/<non-empty id>` at the type
 * level.
 */
type Reference = `DocumentReference/${string}`

const makeReference = (id: string): Reference => `${REFERENCE_PREFIX}${id}`

const idFromReference = (ref: Reference): string => ref.slice(REFERENCE_PREFIX.length)

// ─── Decode ─────────────────────────────────────────────────────────────────

/**
 * One format's per-file decode step, given the file, its settings, and the
 * reference to the source file every resource it yields will be stamped with —
 * minted for a `local` pick, the existing one for a `server` pick.
 */
type DecodeOne<TSettings> = (
  file: PickedFile,
  settings: TSettings,
  sourceFile: Reference
) => Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError>

/** A subject a minted source file is filed under, when the format names one. */
interface Subject {
  readonly reference: string
}

/**
 * How a format names the subject its minted source file is filed under.
 *
 * @remarks
 * Called with the file's *decode*, not just its bytes, so a format reads the
 * subject off the resources it already extracted rather than parsing the file
 * twice. `undefined` leaves the source file with no `subject` — the default,
 * which keeps an engineering artifact out of `Patient/$everything`.
 */
type SubjectFor = (file: PickedFile, decoded: DecodedFile.DecodedFile) => Subject | undefined

interface PerFileDecodeOptions {
  readonly subjectFor?: SubjectFor | undefined
}

/** The review key of a minted source-file row, stable across a settings re-decode. */
const key = (fileName: string): string => `source-file/${fileName}`

/** The section title every minted source-file row is reviewed under. */
const SECTION_TITLE = 'Source file'

const prependToDecodedFile = (
  decoded: DecodedFile.DecodedFile,
  sourceFile: DecodedFile.Resource | undefined
): DecodedFile.DecodedFile => {
  if (sourceFile === undefined) return decoded
  const section: DecodedFile.Section = {
    title: SECTION_TITLE,
    resources: [sourceFile],
  }
  return { ...decoded, sections: [section, ...decoded.sections] }
}

export { SECTION_TITLE, idFromReference, key, makeReference, prependToDecodedFile }
export type { DecodeOne, PerFileDecodeOptions, Reference, Subject, SubjectFor, Type }
