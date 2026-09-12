import { DateTime, Effect, Either, Encoding, ParseResult, Schema } from 'effect'
import { DocumentReference } from 'fhir-r4/resources'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { sha256Base64 } from 'web-trace-core/capture'

import { LIFELABS_SYSTEM } from '../source-system.ts'

/**
 * The single definition of how a whole LifeLabs report PDF is stored as a FHIR
 * R4 `DocumentReference` — one schema, plus the two directions derived from
 * it.
 *
 * @remarks
 * This is the LifeLabs *archive* encoding, structurally analogous to
 * `har-importer-core/archive/har-archive-codec.ts` (differences: PDF content
 * type, LifeLabs coding, no web-trace security label). Nothing here parses
 * the PDF; the bytes are carried, hashed, and handed back exactly as they
 * arrived. Reading them is `positioned-text-web`'s `extractPositionedText`
 * followed by the dialect, through `decodeLifeLabsPdf`.
 *
 * The archive `DocumentReference` is what every FHIR resource this importer
 * writes stamps onto `meta.source` — the provenance link that lets a reader
 * trace a `Patient`, `DiagnosticReport`, or `Observation` back to the raw
 * PDF it came from.
 *
 * When a third source-archive format lands, factor the shared shape (id,
 * fileName, uploadedAt, bytes, hash, base64-on-the-wire, no `subject`,
 * single `transformOrFail`) into a `sourceArchiveCodec(config)` builder that
 * takes coding/contentType/securityLabel as data.
 *
 * @packageDocumentation
 */

/**
 * The coding for the LifeLabs PDF archive category. Reuses
 * `LIFELABS_SYSTEM` (the source-system URI resources are keyed under) with a
 * distinct code so the `type`/`category` axis is discoverable from one
 * place.
 */
const LIFELABS_PDF_ARCHIVE_CODE = 'lifelabs-pdf-archive'

/**
 * The `category` search token every server-side archive read filters on, in
 * FHIR's `system|code` form so a bare `lifelabs-pdf-archive` code in some
 * other system cannot match.
 */
const LIFELABS_PDF_ARCHIVE_CATEGORY_TOKEN =
  `${LIFELABS_SYSTEM}|${LIFELABS_PDF_ARCHIVE_CODE}` as const

/** The attachment's media type — the actual PDF content type. */
const LIFELABS_PDF_ARCHIVE_CONTENT_TYPE = 'application/pdf'

/**
 * The FHIR resource id of an uploaded LifeLabs PDF archive.
 *
 * @remarks
 * FHIR R4's own `id` grammar. A caller mints a **fresh uuid per upload**:
 * the same PDF uploaded twice is two documents, deliberately, so an upload
 * never silently overwrites an earlier one. Dedupe stays *detectable* — the
 * attachment's `hash` and `size` are over the same bytes — without being
 * forced.
 */
const LifeLabsPdfArchiveId = Schema.NonEmptyString.pipe(
  Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/u)
).annotations({
  identifier: 'LifeLabsPdfArchiveId',
  description: 'FHIR resource id of an uploaded LifeLabs PDF archive; a fresh uuid per upload.',
})

/**
 * One uploaded LifeLabs report PDF.
 *
 * @remarks
 * `bytes` is the file verbatim — base64 on the wire, a `Uint8Array` decoded,
 * and never a UTF-8 round trip (a PDF is binary and would not survive one).
 * `uploadedAt` is when this system received the file, not the report's
 * printed instant.
 */
const LifeLabsPdfArchive = Schema.Struct({
  id: LifeLabsPdfArchiveId,
  fileName: Schema.NonEmptyString,
  uploadedAt: Schema.DateTimeUtc,
  bytes: Schema.Uint8ArrayFromBase64,
})

type LifeLabsPdfArchive = typeof LifeLabsPdfArchive.Type

// The `ParseResult.*` variants (rather than `Schema.*`) fail with a bare
// `ParseIssue`, which is what a `transformOrFail` step has to return.
const decodeResource = ParseResult.decodeUnknown(DocumentReference.Schema)
const encodeResource = ParseResult.encode(DocumentReference.Schema)
const decodeArchive = ParseResult.decodeUnknown(LifeLabsPdfArchive)

/**
 * Encodes an uploaded PDF archive as the FHIR R4 `DocumentReference` wire
 * object.
 *
 * @remarks
 * `subject` is deliberately absent — a LifeLabs PDF is an engineering
 * artifact that happens to contain a patient's PHI, and leaving `subject`
 * unset keeps it out of `Patient/$everything` and clinical exports. The
 * dialect-parsed resources (Patient, DiagnosticReport, Observation) each
 * carry their own `subject`; the archive stays reachable by `category`
 * search.
 *
 * The hash is a parameter because Web Crypto's digest is `Promise`-returning
 * and this builder is not — the `transformOrFail`'s encode direction
 * computes it. A digest of anything but these bytes would make the resource
 * lie about its own content.
 */
const lifeLabsPdfArchiveToWire = (
  archive: LifeLabsPdfArchive,
  hash: string
): FhirR4.DocumentReference => {
  const uploadedAt = DateTime.formatIso(archive.uploadedAt)
  return {
    resourceType: 'DocumentReference',
    id: archive.id,
    status: 'current',
    type: { coding: [{ system: LIFELABS_SYSTEM, code: LIFELABS_PDF_ARCHIVE_CODE }] },
    category: [{ coding: [{ system: LIFELABS_SYSTEM, code: LIFELABS_PDF_ARCHIVE_CODE }] }],
    date: uploadedAt,
    description: `LifeLabs report PDF: ${archive.fileName}`,
    content: [
      {
        attachment: {
          contentType: LIFELABS_PDF_ARCHIVE_CONTENT_TYPE,
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

/** Whether a `CodeableConcept`-shaped value carries the LifeLabs-PDF-archive coding. */
const hasArchiveCoding = (concept: FhirR4.CodeableConcept | undefined): boolean =>
  (concept?.coding ?? []).some(
    (coding) => coding.system === LIFELABS_SYSTEM && coding.code === LIFELABS_PDF_ARCHIVE_CODE
  )

/**
 * Reads the archive out of a `DocumentReference` wire object, or names the
 * first thing the encoding requires and the resource does not carry.
 */
const readEncodedArchive = (wire: FhirR4.DocumentReference): Either.Either<unknown, string> => {
  if (!hasArchiveCoding(wire.type) || !(wire.category ?? []).some(hasArchiveCoding)) {
    return Either.left(`Not a ${LIFELABS_PDF_ARCHIVE_CODE} document`)
  }

  const attachment = wire.content?.[0]?.attachment
  if (attachment === undefined) return Either.left('No content entry')
  if (attachment.data === undefined) return Either.left('Attachment carries no data')

  return Either.right({
    id: wire.id,
    fileName: attachment.title,
    uploadedAt: attachment.creation ?? wire.date,
    bytes: attachment.data,
  })
}

/**
 * The archive encoding, as one schema: a decoded FHIR R4 `DocumentReference`
 * on the encoded side, a {@link LifeLabsPdfArchive} on the decoded side.
 */
const LifeLabsPdfArchiveFromDocumentReference: Schema.Schema<
  LifeLabsPdfArchive,
  typeof DocumentReference.Schema.Type
> = Schema.transformOrFail(
  Schema.typeSchema(DocumentReference.Schema),
  Schema.typeSchema(LifeLabsPdfArchive),
  {
    strict: true,
    decode: (resource, _options, ast) =>
      encodeResource(resource).pipe(
        Effect.flatMap((wire) =>
          Either.match(readEncodedArchive(wire), {
            onLeft: (reason) =>
              Effect.fail(
                new ParseResult.Type(ast, resource, `${wire.id ?? '<no id>'}: ${reason}`)
              ),
            onRight: (value) => decodeArchive(value),
          })
        )
      ),
    encode: (archive, _options, ast) =>
      sha256Base64(new Uint8Array(archive.bytes)).pipe(
        Effect.mapError((error) => new ParseResult.Type(ast, archive, error.reason)),
        Effect.flatMap((hash) => decodeResource(lifeLabsPdfArchiveToWire(archive, hash)))
      ),
  }
).annotations({
  identifier: 'LifeLabsPdfArchiveFromDocumentReference',
  description: 'One uploaded LifeLabs report PDF, encoded as a FHIR R4 DocumentReference.',
})

/** The same encoding, reading from raw FHIR JSON. */
const LifeLabsPdfArchiveFromFhirJson: Schema.Schema<LifeLabsPdfArchive, FhirR4.DocumentReference> =
  Schema.compose(DocumentReference.Schema, LifeLabsPdfArchiveFromDocumentReference).annotations({
    identifier: 'LifeLabsPdfArchiveFromFhirJson',
    description: 'One uploaded LifeLabs report PDF, encoded as FHIR R4 DocumentReference JSON.',
  })

/** Encodes an uploaded LifeLabs PDF archive as a decoded FHIR R4 `DocumentReference`. */
const lifeLabsPdfArchiveToDocumentReference = Schema.encode(LifeLabsPdfArchiveFromDocumentReference)

/** Reads a decoded `DocumentReference` back as the LifeLabs PDF archive it carries. */
const lifeLabsPdfArchiveFromDocumentReference = Schema.decode(
  LifeLabsPdfArchiveFromDocumentReference
)

/**
 * Whether a decoded `DocumentReference` is an uploaded LifeLabs PDF
 * archive, by `category`.
 */
const isLifeLabsPdfArchive = (resource: typeof DocumentReference.Schema.Type): boolean =>
  resource.category.some((category) =>
    category.coding.some(
      (coding) =>
        coding.system?.toString() === LIFELABS_SYSTEM && coding.code === LIFELABS_PDF_ARCHIVE_CODE
    )
  )

export {
  isLifeLabsPdfArchive,
  LIFELABS_PDF_ARCHIVE_CATEGORY_TOKEN,
  LIFELABS_PDF_ARCHIVE_CODE,
  LIFELABS_PDF_ARCHIVE_CONTENT_TYPE,
  LifeLabsPdfArchive,
  LifeLabsPdfArchiveFromDocumentReference,
  LifeLabsPdfArchiveFromFhirJson,
  lifeLabsPdfArchiveFromDocumentReference,
  LifeLabsPdfArchiveId,
  lifeLabsPdfArchiveToDocumentReference,
  lifeLabsPdfArchiveToWire,
}
