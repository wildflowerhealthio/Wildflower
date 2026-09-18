/**
 * The source-file vocabulary every format binding shares: the decoded upload
 * itself, the coding axis it is tagged on, and the typed reference that is this
 * slice's one currency for "which source file".
 *
 * @remarks
 * A `server` pick already carries a {@link Reference}, a `local` pick's mint
 * produces an id {@link makeReference} wraps, and {@link idFromReference} is for
 * the one format (DICOM) that needs the bare id to build a resource link out of.
 *
 * Nothing here is parameterised by a format, and nothing here does more at
 * runtime than concatenate or slice a string. The codec that turns one of these
 * into the FHIR `DocumentReference` it is stored as — and back — is
 * `source-file-codec.ts`, the half a format's coding constants parameterise.
 * Keeping the two apart is what lets `picked-file-source.ts` and
 * `meta-source.ts` name a `Reference` without pulling the codec, its schemas and
 * the digest in behind it.
 *
 * @packageDocumentation
 */

import type { DateTime } from 'effect'

/** One uploaded source file, decoded: its id, name, upload instant, and bytes. */
interface Type {
  readonly id: string
  readonly fileName: string
  readonly uploadedAt: DateTime.Utc
  readonly bytes: Uint8Array
}

/** A `system`/`code` pair — the axis one format's source files are tagged on. */
interface Coding {
  readonly system: string
  readonly code: string
}

const REFERENCE_PREFIX = 'DocumentReference/'

/**
 * A typed FHIR reference to a source file's `DocumentReference`, carrying the
 * invariant that the string is `DocumentReference/<non-empty id>` at the type
 * level.
 */
type Reference = `DocumentReference/${string}`

const makeReference = (id: string): Reference => `${REFERENCE_PREFIX}${id}`

const idFromReference = (ref: Reference): string => ref.slice(REFERENCE_PREFIX.length)

export { idFromReference, makeReference }
export type { Coding, Reference, Type }
