/**
 * The source-file vocabulary every format binding shares: the `Type` a
 * format's `decode` mints or resolves, the deterministic `Ref` a `DecodeOne`
 * receives, the `SECTION_TITLE` / `key` the review prepends a minted row
 * under, and the `Reference` — `DocumentReference/<id>` — a stamped
 * resource's `meta.source` points at.
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

const isReference = (value: string): value is Reference =>
  value.startsWith(REFERENCE_PREFIX) && value.length > REFERENCE_PREFIX.length

// ─── Decode ─────────────────────────────────────────────────────────────────

/** The resolved source id a `DecodeOne` receives — minted for a `local` pick, read back for a `server` one. */
interface Ref {
  readonly id: string
}

/** One format's per-file decode step, given the file, its settings, and the resolved source. */
type DecodeOne<TSettings> = (
  file: PickedFile,
  settings: TSettings,
  source: Ref
) => Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError>

interface PerFileDecodeOptions {
  readonly subjectFor?: (file: PickedFile) => { readonly reference: string } | undefined
}

/** The review key of a minted source-file row, stable across a settings re-decode. */
const key = (fileName: string): string => `source-file/${fileName}`

/** The section title every minted source-file row is reviewed under. */
const SECTION_TITLE = 'Source file'

export { SECTION_TITLE, idFromReference, isReference, key, makeReference }
export type { DecodeOne, PerFileDecodeOptions, Ref, Reference, Type }
