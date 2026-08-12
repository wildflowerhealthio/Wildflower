import { DateTime, Effect, Encoding, ParseResult, Schema } from 'effect'
import { DocumentReference } from 'fhir-r4/resources'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { sha256Base64 } from '../capture/body.ts'
import type { DocumentReferenceType } from './document-reference-codec.ts'
import {
  HAR_ARCHIVE_CODE,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
} from './systems.ts'

/**
 * The single definition of how a whole `.har` file is stored as a FHIR R4
 * `DocumentReference` — one schema, plus the two directions derived from it.
 *
 * @remarks
 * This is the *archive* encoding, not the trace encoding. A trace is one
 * recorded HTTP exchange this system captured itself
 * (`document-reference-codec.ts`); an archive is an opaque `.har` file someone
 * uploaded, kept whole so the importer can parse it later. The two share a code
 * system and nothing else, and {@link isHarArchive} / `isWebTrace` are disjoint
 * by construction — the viewer must never list an archive and the importer must
 * never list a trace.
 *
 * Nothing here parses HAR. The bytes are carried, hashed, and handed back
 * exactly as they arrived.
 *
 * @packageDocumentation
 */

/**
 * The attachment's media type.
 *
 * @remarks
 * HAR has no registered MIME type — the format is JSON, and `.har` files are
 * served as `application/json` in practice. The coding, not the content type, is
 * what says "this is a HAR archive"; a reader must not discriminate on this
 * value.
 */
const HAR_ARCHIVE_CONTENT_TYPE = 'application/json'

/**
 * The FHIR resource id of an uploaded archive.
 *
 * @remarks
 * FHIR R4's own `id` grammar. A caller mints a **fresh uuid per upload**: the
 * same file uploaded twice is two documents, deliberately, so an upload never
 * silently overwrites an earlier one. Dedupe stays *detectable* — the
 * attachment's `hash` and `size` are over the same bytes — without being forced.
 *
 * A refinement rather than a bare string so an id that FHIR would reject fails
 * at the encode rather than at the server.
 */
const HarArchiveId = Schema.NonEmptyString.pipe(
  Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/u)
).annotations({
  identifier: 'HarArchiveId',
  description: 'FHIR resource id of an uploaded HAR archive; a fresh uuid per upload.',
})

/**
 * One uploaded `.har` file.
 *
 * @remarks
 * `bytes` is the file verbatim — base64 on the wire, a `Uint8Array` decoded, and
 * never a UTF-8 round trip. A HAR is JSON, but a truncated or mis-encoded upload
 * is stored as it arrived rather than mangled, so the `hash` means something and
 * the parser downstream sees exactly what the user handed over.
 *
 * `uploadedAt` is when this system received the file, not anything the archive
 * claims about itself: the recording instants inside a HAR belong to whoever
 * recorded it, and this encoding never reads them.
 */
const HarArchive = Schema.Struct({
  id: HarArchiveId,
  fileName: Schema.NonEmptyString,
  uploadedAt: Schema.DateTimeUtc,
  bytes: Schema.Uint8ArrayFromBase64,
})

type HarArchive = typeof HarArchive.Type

// The `ParseResult.*` variants (rather than `Schema.*`) fail with a bare
// `ParseIssue`, which is what a `transformOrFail` step has to return.
const decodeResource = ParseResult.decodeUnknown(DocumentReference.Schema)
const encodeResource = ParseResult.encode(DocumentReference.Schema)
const decodeArchive = ParseResult.decodeUnknown(HarArchive)

/**
 * Encodes an uploaded archive as the FHIR R4 `DocumentReference` wire object.
 *
 * @param archive - The archive to encode
 * @param hash - The base64 SHA-256 of `archive.bytes`, as {@link sha256Base64} produces it
 * @returns The wire-format resource, ready to decode or to write
 *
 * @remarks
 * The hash is a parameter rather than something computed here because Web
 * Crypto's digest is `Promise`-returning and this builder is not: the schema's
 * encode direction computes it and hands it in. Passing a digest of anything
 * other than these bytes would make the resource lie about its own content —
 * {@link HarArchiveFromDocumentReference} is the only caller that should exist.
 *
 * `subject` is deliberately absent, for the same reason it is on a trace: an
 * archive is an engineering artifact that happens to contain PHI, and leaving
 * `subject` unset keeps it out of `Patient/$everything` and out of clinical
 * exports. It stays reachable by `category` search.
 */
const harArchiveToWire = (archive: HarArchive, hash: string): FhirR4.DocumentReference => {
  const uploadedAt = DateTime.formatIso(archive.uploadedAt)
  return {
    resourceType: 'DocumentReference',
    id: archive.id,
    status: 'current',
    type: { coding: [{ system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE }] },
    category: [{ coding: [{ system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE }] }],
    date: uploadedAt,
    description: `HAR archive: ${archive.fileName}`,
    // An uploaded archive is unredacted by construction — it is whatever the
    // recorder captured. Same marker a trace carries, so "raw" means one thing
    // across the slice.
    securityLabel: [{ coding: [{ system: WEB_TRACE_REDACTION_SYSTEM, code: WEB_TRACE_RAW_CODE }] }],
    content: [
      {
        attachment: {
          contentType: HAR_ARCHIVE_CONTENT_TYPE,
          data: Encoding.encodeBase64(archive.bytes),
          size: archive.bytes.length,
          hash,
          title: archive.fileName,
          creation: uploadedAt,
        },
      },
    ],
  }
}

/** Whether a `CodeableConcept`-shaped value carries the HAR-archive coding. */
const hasArchiveCoding = (concept: FhirR4.CodeableConcept | undefined): boolean =>
  (concept?.coding ?? []).some(
    (coding) => coding.system === WEB_TRACE_CODE_SYSTEM && coding.code === HAR_ARCHIVE_CODE
  )

/**
 * Reads the archive out of a `DocumentReference` wire object, or names the first
 * thing the encoding requires and the resource does not carry.
 *
 * @remarks
 * Returns the *encoded* form for {@link HarArchive} to decode, so a wire value of
 * the wrong type — an id outside FHIR's grammar, a `data` that is not base64 —
 * fails as a `ParseIssue` against the schema rather than as a hand-written check
 * here.
 *
 * The coding is checked first and is not negotiable: without it a trace resource
 * would decode as an archive whose "HAR file" is one response body. Disjointness
 * is the whole point of the separate code.
 *
 * The bytes are taken as they are. `hash` and `size` are written from the same
 * bytes on encode and are left for a reader that wants to dedupe or verify;
 * re-digesting a multi-megabyte file on every read would buy nothing this
 * package needs.
 */
const readEncodedArchive = (
  wire: FhirR4.DocumentReference
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string } => {
  if (!hasArchiveCoding(wire.type) || !(wire.category ?? []).some(hasArchiveCoding)) {
    return { ok: false, reason: `Not a ${HAR_ARCHIVE_CODE} document` }
  }

  const attachment = wire.content?.[0]?.attachment
  if (attachment === undefined) return { ok: false, reason: 'No content entry' }
  if (attachment.data === undefined) return { ok: false, reason: 'Attachment carries no data' }

  return {
    ok: true,
    value: {
      id: wire.id,
      fileName: attachment.title,
      // `creation` is the upload instant this codec writes; `date` mirrors it so
      // the resource is orderable by a plain FHIR search. Either will do, and an
      // archive written by something else may carry only one.
      uploadedAt: attachment.creation ?? wire.date,
      bytes: attachment.data,
    },
  }
}

/**
 * The archive encoding, as one schema: a decoded FHIR R4 `DocumentReference` on
 * the encoded side, a {@link HarArchive} on the decoded side.
 *
 * @remarks
 * This is the single definition — {@link harArchiveToDocumentReference} and
 * {@link harArchiveFromDocumentReference} are `Schema.encode` / `Schema.decode`
 * of it. Both directions fail the way any schema does, with a `ParseError`: a
 * resource without the HAR-archive coding, without a content entry, or with no
 * attachment data raises a `ParseResult.Type` issue naming what was wrong, and
 * anything present but ill-typed fails against {@link HarArchive} itself.
 *
 * The encode direction is effectful because it hashes: SHA-256 comes from Web
 * Crypto (this is the pure layer — no `node:crypto`), whose digest is
 * `Promise`-returning. `Schema.encode` already returns an `Effect`, so this
 * costs the caller nothing new.
 */
const HarArchiveFromDocumentReference: Schema.Schema<HarArchive, DocumentReferenceType> =
  Schema.transformOrFail(
    Schema.typeSchema(DocumentReference.Schema),
    Schema.typeSchema(HarArchive),
    {
      strict: true,
      decode: (resource, _options, ast) =>
        encodeResource(resource).pipe(
          Effect.flatMap((wire) => {
            const read = readEncodedArchive(wire)
            return read.ok
              ? decodeArchive(read.value)
              : Effect.fail(
                  new ParseResult.Type(ast, resource, `${wire.id ?? '<no id>'}: ${read.reason}`)
                )
          })
        ),
      encode: (archive, _options, ast) =>
        sha256Base64(new Uint8Array(archive.bytes)).pipe(
          Effect.mapError((error) => new ParseResult.Type(ast, archive, error.reason)),
          Effect.flatMap((hash) => decodeResource(harArchiveToWire(archive, hash)))
        ),
    }
  ).annotations({
    identifier: 'HarArchiveFromDocumentReference',
    description: 'One uploaded HAR file, encoded as a FHIR R4 DocumentReference.',
  })

/**
 * The same encoding, reading from raw FHIR JSON.
 *
 * @remarks
 * {@link HarArchiveFromDocumentReference} starts from a resource that has
 * already been decoded; this one starts from what a FHIR server actually sends,
 * so `Schema.decodeUnknown` on a search entry reaches a {@link HarArchive} in one
 * step and `Schema.encode` produces a body ready to `PUT`.
 */
const HarArchiveFromFhirJson: Schema.Schema<HarArchive, FhirR4.DocumentReference> = Schema.compose(
  DocumentReference.Schema,
  HarArchiveFromDocumentReference
).annotations({
  identifier: 'HarArchiveFromFhirJson',
  description: 'One uploaded HAR file, encoded as FHIR R4 DocumentReference JSON.',
})

/**
 * Encodes an uploaded archive as a decoded FHIR R4 `DocumentReference`.
 *
 * @remarks
 * `Schema.encode` of {@link HarArchiveFromDocumentReference}, named for the
 * direction callers read it in. Hashes the bytes on the way through, which is
 * the only reason it can fail on well-formed input: a `BodyDigestUnavailable`
 * (an insecure context, no `crypto.subtle`) surfaces as a `ParseError`.
 */
const harArchiveToDocumentReference = Schema.encode(HarArchiveFromDocumentReference)

/**
 * Reads a decoded `DocumentReference` back as the archive it carries.
 *
 * @remarks
 * `Schema.decode` of {@link HarArchiveFromDocumentReference}, the inverse of
 * {@link harArchiveToDocumentReference}; the two are tested as such. A trace
 * resource fails here rather than decoding into a nonsense archive.
 */
const harArchiveFromDocumentReference = Schema.decode(HarArchiveFromDocumentReference)

/**
 * Whether a decoded `DocumentReference` is an uploaded HAR archive, by
 * `category`.
 *
 * @param resource - Any decoded `DocumentReference`
 * @returns `true` when the resource carries the HAR-archive category coding
 *
 * @remarks
 * The counterpart of `isWebTrace`, and disjoint from it: the two predicates test
 * different codes on the same axis, so no document satisfies both. That is
 * load-bearing — the web-trace viewer lists traces, the importer lists archives,
 * and neither may see the other's documents.
 */
const isHarArchive = (resource: DocumentReferenceType): boolean =>
  resource.category.some((category) =>
    category.coding.some(
      (coding) =>
        coding.system?.toString() === WEB_TRACE_CODE_SYSTEM && coding.code === HAR_ARCHIVE_CODE
    )
  )

export {
  HAR_ARCHIVE_CONTENT_TYPE,
  HarArchive,
  HarArchiveFromDocumentReference,
  HarArchiveFromFhirJson,
  harArchiveFromDocumentReference,
  HarArchiveId,
  harArchiveToDocumentReference,
  harArchiveToWire,
  isHarArchive,
}
