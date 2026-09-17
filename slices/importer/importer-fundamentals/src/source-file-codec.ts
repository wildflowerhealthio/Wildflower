import { DateTime, Effect, Either, Encoding, ParseResult, Schema } from 'effect'
import { joinIdComponents, localResourceId } from 'fhir-r4/identity'
import { DocumentReference } from 'fhir-r4/resources'

import type * as FhirR4 from 'fhir/r4.d.ts'

import type { DocumentReferenceType } from './file-importer-descriptor.ts'
import { sha256Base64 } from './sha256.ts'

/**
 * The one definition of how a whole uploaded source file — a `.har`, a report
 * PDF, a `.dcm` — is stored as a FHIR R4 `DocumentReference`: one attachment
 * carrying the bytes verbatim, keyed under a per-format `type`/`category`
 * coding.
 *
 * @remarks
 * The HAR and LifeLabs codecs were byte-for-byte identical bar the coding, the
 * content type, the description text, and (HAR only) a `securityLabel`.
 * {@link sourceFileCodec} takes exactly those as data, so a binding supplies
 * its coding (a HAR binding passes `web-trace-core`'s constants; nothing here
 * imports that slice) and gets the whole codec back — the schema, both
 * directions, `isSourceFile`, the category token, and the pure wire builder.
 * Adding another source-file format is now one config literal.
 *
 * Nothing here parses the source file. The bytes are carried, hashed, and
 * handed back exactly as they arrived; reading them is each binding's own job.
 *
 * `buildSourceFile` is the single mint for a picked file's source-file
 * resource: it derives a **deterministic** id from the file's SHA-256 and
 * name — via `fhir-r4/identity`'s {@link localResourceId}, the same derivation
 * every stored resource id comes from — so re-importing the same bytes under
 * the same name overwrites rather than duplicating. It lives here (rather than
 * duplicated per binding) because the id needs the digest and the shared
 * derivation, both of which this package already owns.
 *
 * `subject` is absent by default, the same as a trace: a source file is an
 * engineering artifact that happens to contain PHI, and leaving `subject` unset
 * keeps it out of `Patient/$everything` and clinical exports. It stays
 * reachable by `category` search. Formats that embed a patient identity
 * (DICOM) may pass a `subject` to {@link SourceFileCodec.buildSourceFile} to
 * link the archive to its patient.
 *
 * @packageDocumentation
 */

/** A `system|code` coding pair, the unit a source file's `type`/`category` carries. */
interface Coding {
  readonly system: string
  readonly code: string
}

/** The per-format data {@link sourceFileCodec} needs to build one format's source-file codec. */
interface SourceFileConfig<TFormat extends string> {
  /** The format tag this codec belongs to — carried onto the codec for `perFileDecode`. */
  readonly format: TFormat
  /** The `type`/`category` coding that says "this is a source file of this format". */
  readonly coding: Coding
  /** The attachment's media type (`application/json` for HAR, `application/pdf` for LifeLabs). */
  readonly contentType: string
  /** Prefixed onto the file name for `DocumentReference.description` (`'HAR archive: '`). */
  readonly descriptionPrefix: string
  /**
   * The `securityLabel` codings, when the format carries one (HAR marks its
   * source file raw, the same as a trace). Omitted entirely when absent.
   */
  readonly securityLabel?: readonly Coding[] | undefined
  /** The schema `identifier` stem, e.g. `'HarSourceFile'` — the id and both directions name off it. */
  readonly sourceFileName: string
  /** A one-line description of the source file, e.g. `'One uploaded HAR file'`. */
  readonly label: string
  /** The `description` annotation for the source-file-id refinement schema. */
  readonly idDescription: string
}

/** One uploaded source file: the bytes verbatim, plus who/when this system received it. */
interface SourceFile {
  readonly id: string
  readonly fileName: string
  readonly uploadedAt: DateTime.Utc
  readonly bytes: Uint8Array
}

/** The wire (encoded) shape of a {@link SourceFile} — every field a base64/ISO string. */
interface SourceFileEncoded {
  readonly id: string
  readonly fileName: string
  readonly uploadedAt: string
  readonly bytes: string
}

/**
 * The arguments {@link SourceFileCodec.toWire} takes: one source file, the
 * digest of its bytes, and the `subject` to link it to.
 *
 * @remarks
 * `subject` is required-but-nullable rather than optional so every call site
 * states, in the literal it passes, whether the resource gets a subject —
 * leaving it off is a decision (see this module's docs on why a source file
 * carries no subject by default), not a default to fall into silently.
 */
interface SourceFileWireParams {
  readonly sourceFile: SourceFile
  /** The bytes' SHA-256, precomputed — `toWire` stamps it on the attachment rather than hashing again. */
  readonly hash: string
  /** The `subject` reference, or `undefined` to leave the resource without one. */
  readonly subject: { readonly reference: string } | undefined
}

/** The codec {@link sourceFileCodec} returns for one format. */
interface SourceFileCodec<TFormat extends string> {
  /** The format tag this codec was built for. */
  readonly format: TFormat
  /** The attachment's media type — drives the preview modal's renderer choice. */
  readonly contentType: string
  /** The decoded-side schema: `{ id, fileName, uploadedAt, bytes }`. */
  readonly SourceFile: Schema.Schema<SourceFile, SourceFileEncoded>
  /** The FHIR resource id refinement — matches the id `buildSourceFile` derives. */
  readonly SourceFileId: Schema.Schema<string, string>
  /** The encoding as one schema: a decoded `DocumentReference` on the encoded side. */
  readonly SourceFileFromDocumentReference: Schema.Schema<SourceFile, DocumentReferenceType>
  /** The same encoding, reading from raw FHIR JSON. */
  readonly SourceFileFromFhirJson: Schema.Schema<SourceFile, FhirR4.DocumentReference>
  /** `Schema.encode` of {@link SourceFileFromDocumentReference} — a source file to a decoded resource. */
  readonly sourceFileToDocumentReference: (
    sourceFile: SourceFile
  ) => Effect.Effect<DocumentReferenceType, ParseResult.ParseError>
  /** `Schema.decode` of {@link SourceFileFromDocumentReference} — a decoded resource back to its source file. */
  readonly sourceFileFromDocumentReference: (
    resource: DocumentReferenceType
  ) => Effect.Effect<SourceFile, ParseResult.ParseError>
  /** The pure wire builder — a source file plus its precomputed hash to a `DocumentReference` object. */
  readonly toWire: (wire: SourceFileWireParams) => FhirR4.DocumentReference
  /** Whether a decoded `DocumentReference` is a source file of this format, by `category`. */
  readonly isSourceFile: (resource: DocumentReferenceType) => boolean
  /** The `system|code` `category` search token every server-side read filters on. */
  readonly categoryToken: string
  /**
   * Mint a picked file's source-file resource: a deterministic id (from the
   * bytes' SHA-256 and the file name), the upload instant, and the encoded
   * `DocumentReference`. The descriptor's `buildSourceFile` — pure, writes
   * nothing. Fails only as a `ParseError` (a digest unavailable in an insecure
   * context).
   */
  readonly buildSourceFile: (
    picked: {
      readonly fileName: string
      readonly bytes: Uint8Array
    },
    options?: { readonly subject?: { readonly reference: string } }
  ) => Effect.Effect<DocumentReferenceType, ParseResult.ParseError>
}

/**
 * Build one format's source-file codec from its coding and content type.
 *
 * @param config - The per-format coding, content type, description prefix, and
 *   optional security label — everything that differs between formats
 * @returns The codec: the `SourceFile` schema and its `SourceFileId`
 *   refinement, both directions (`SourceFileFromDocumentReference` /
 *   `SourceFileFromFhirJson` and their `encode`/`decode`), the pure `toWire`
 *   builder, `isSourceFile`, and the `categoryToken`
 */
const sourceFileCodec = <TFormat extends string>(
  config: SourceFileConfig<TFormat>
): SourceFileCodec<TFormat> => {
  const { coding, contentType, descriptionPrefix, securityLabel } = config

  const SourceFileId = Schema.NonEmptyString.pipe(
    Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/u)
  ).annotations({ identifier: `${config.sourceFileName}Id`, description: config.idDescription })

  const SourceFileSchema = Schema.Struct({
    id: SourceFileId,
    fileName: Schema.NonEmptyString,
    uploadedAt: Schema.DateTimeUtc,
    bytes: Schema.Uint8ArrayFromBase64,
  })

  // The `ParseResult.*` variants (rather than `Schema.*`) fail with a bare
  // `ParseIssue`, which is what a `transformOrFail` step has to return.
  const decodeResource = ParseResult.decodeUnknown(DocumentReference.Schema)
  const encodeResource = ParseResult.encode(DocumentReference.Schema)
  const decodeSourceFile = ParseResult.decodeUnknown(SourceFileSchema)

  const toWire = ({
    sourceFile,
    hash,
    subject,
  }: SourceFileWireParams): FhirR4.DocumentReference => {
    const uploadedAt = DateTime.formatIso(sourceFile.uploadedAt)
    return {
      resourceType: 'DocumentReference',
      id: sourceFile.id,
      status: 'current',
      type: { coding: [{ system: coding.system, code: coding.code }] },
      category: [{ coding: [{ system: coding.system, code: coding.code }] }],
      date: uploadedAt,
      description: `${descriptionPrefix}${sourceFile.fileName}`,
      ...(subject === undefined ? {} : { subject }),
      ...(securityLabel === undefined
        ? {}
        : { securityLabel: [{ coding: securityLabel.map((one) => ({ ...one })) }] }),
      content: [
        {
          attachment: {
            contentType,
            data: Encoding.encodeBase64(sourceFile.bytes),
            size: sourceFile.bytes.length,
            hash,
            title: sourceFile.fileName,
            creation: uploadedAt,
          },
        },
      ],
    }
  }

  /** Whether a `CodeableConcept`-shaped value carries this format's source-file coding. */
  const hasSourceFileCoding = (concept: FhirR4.CodeableConcept | undefined): boolean =>
    (concept?.coding ?? []).some((one) => one.system === coding.system && one.code === coding.code)

  /** Read the source file out of a wire resource, or name the first thing it does not carry. */
  const readEncodedSourceFile = (
    wire: FhirR4.DocumentReference
  ): Either.Either<unknown, string> => {
    if (!hasSourceFileCoding(wire.type) || !(wire.category ?? []).some(hasSourceFileCoding)) {
      return Either.left(`Not a ${coding.code} document`)
    }
    const attachment = wire.content?.[0]?.attachment
    if (attachment === undefined) return Either.left('No content entry')
    if (attachment.data === undefined) return Either.left('Attachment carries no data')
    return Either.right({
      id: wire.id,
      fileName: attachment.title,
      // `creation` is the upload instant this codec writes; `date` mirrors it so
      // the resource is orderable by a plain FHIR search. Either will do.
      uploadedAt: attachment.creation ?? wire.date,
      bytes: attachment.data,
    })
  }

  const SourceFileFromDocumentReference: Schema.Schema<SourceFile, DocumentReferenceType> =
    Schema.transformOrFail(
      Schema.typeSchema(DocumentReference.Schema),
      Schema.typeSchema(SourceFileSchema),
      {
        strict: true,
        decode: (resource, _options, ast) =>
          encodeResource(resource).pipe(
            Effect.flatMap((wire) =>
              Either.match(readEncodedSourceFile(wire), {
                onLeft: (reason) =>
                  Effect.fail(
                    new ParseResult.Type(ast, resource, `${wire.id ?? '<no id>'}: ${reason}`)
                  ),
                onRight: (value) => decodeSourceFile(value),
              })
            )
          ),
        encode: (sourceFile, _options, ast) =>
          sha256Base64(new Uint8Array(sourceFile.bytes)).pipe(
            Effect.mapError((error) => new ParseResult.Type(ast, sourceFile, error.reason)),
            Effect.flatMap((hash) =>
              decodeResource(toWire({ sourceFile, hash, subject: undefined }))
            )
          ),
      }
    ).annotations({
      identifier: `${config.sourceFileName}FromDocumentReference`,
      description: `${config.label}, encoded as a FHIR R4 DocumentReference.`,
    })

  const SourceFileFromFhirJson: Schema.Schema<SourceFile, FhirR4.DocumentReference> =
    Schema.compose(DocumentReference.Schema, SourceFileFromDocumentReference).annotations({
      identifier: `${config.sourceFileName}FromFhirJson`,
      description: `${config.label}, encoded as FHIR R4 DocumentReference JSON.`,
    })

  const isSourceFile = (resource: DocumentReferenceType): boolean =>
    resource.category.some((category) =>
      category.coding.some(
        (one) => one.system?.toString() === coding.system && one.code === coding.code
      )
    )

  const buildSourceFile = (
    picked: {
      readonly fileName: string
      readonly bytes: Uint8Array
    },
    options?: { readonly subject?: { readonly reference: string } }
  ): Effect.Effect<DocumentReferenceType, ParseResult.ParseError> =>
    Effect.gen(function* () {
      // A fresh `ArrayBuffer`-backed view: `crypto.subtle.digest` requires one,
      // and the same digest is the attachment `hash` `toWire` stamps below —
      // computed once and reused, not hashed twice.
      const bytes = new Uint8Array(picked.bytes)
      const hash = yield* sha256Base64(bytes).pipe(
        Effect.mapError((error) =>
          ParseResult.parseError(new ParseResult.Type(SourceFileSchema.ast, picked, error.reason))
        )
      )
      const uploadedAt = yield* DateTime.now
      // Deterministic in the bytes and the name, so re-importing the same file
      // is the same document (overwrites, never duplicates). Namespaced under
      // the format's coding system, so a HAR and a PDF source file can never
      // collide even on identical (hash, name).
      const id = localResourceId(
        coding.system,
        'DocumentReference',
        joinIdComponents([hash, picked.fileName])
      )
      // `decodeResource` (a `ParseResult.*` variant) fails with a bare
      // `ParseIssue`; lift it to a `ParseError` so this seam matches the
      // descriptor's one error channel.
      return yield* decodeResource(
        toWire({
          sourceFile: { id, fileName: picked.fileName, uploadedAt, bytes },
          hash,
          subject: options?.subject,
        })
      ).pipe(Effect.mapError(ParseResult.parseError))
    })

  return {
    format: config.format,
    contentType,
    SourceFile: SourceFileSchema,
    SourceFileId,
    SourceFileFromDocumentReference,
    SourceFileFromFhirJson,
    sourceFileToDocumentReference: Schema.encode(SourceFileFromDocumentReference),
    sourceFileFromDocumentReference: Schema.decode(SourceFileFromDocumentReference),
    toWire,
    isSourceFile,
    categoryToken: `${coding.system}|${coding.code}`,
    buildSourceFile,
  }
}

export {
  type SourceFile,
  type SourceFileCodec,
  type SourceFileConfig,
  type SourceFileWireParams,
  sourceFileCodec,
}
