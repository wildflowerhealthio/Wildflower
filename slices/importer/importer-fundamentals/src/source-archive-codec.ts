import { DateTime, Effect, Either, Encoding, ParseResult, Schema } from 'effect'
import { joinIdComponents, localResourceId } from 'fhir-r4/identity'
import { DocumentReference } from 'fhir-r4/resources'

import type * as FhirR4 from 'fhir/r4.d.ts'

import type { DocumentReferenceType } from './file-importer-descriptor.ts'
import { sha256Base64 } from './sha256.ts'

/**
 * The one definition of how a whole uploaded source file — a `.har`, a report
 * PDF — is stored as a FHIR R4 `DocumentReference`: one attachment carrying the
 * bytes verbatim, keyed under a per-format `type`/`category` coding.
 *
 * @remarks
 * The HAR and LifeLabs archive codecs were byte-for-byte identical bar the
 * coding, the content type, the description text, and (HAR only) a web-trace
 * `securityLabel`. {@link sourceArchiveCodec} takes exactly those as data, so a
 * binding supplies its coding (a HAR binding passes `web-trace-core`'s
 * constants; nothing here imports that slice) and gets the whole codec back —
 * the schema, both directions, `isArchive`, the category token, and the pure
 * wire builder. Adding a third source-archive format is now one config literal.
 *
 * Nothing here parses the archive. The bytes are carried, hashed, and handed
 * back exactly as they arrived; reading them is each binding's own job.
 *
 * `sourceArchive` is the single mint for a picked file's archive resource:
 * it derives a **deterministic** id from the file's SHA-256 and name — via
 * `fhir-r4/identity`'s {@link localResourceId}, the same derivation every
 * stored resource id comes from — so re-importing the same bytes under the
 * same name overwrites rather than duplicating. It lives here (rather than
 * duplicated per binding) because the id needs the digest and the shared
 * derivation, both of which this package already owns.
 *
 * `subject` is deliberately absent, the same as a trace: an archive is an
 * engineering artifact that happens to contain PHI, and leaving `subject` unset
 * keeps it out of `Patient/$everything` and clinical exports. It stays
 * reachable by `category` search.
 *
 * @packageDocumentation
 */

/** A `system|code` coding pair, the unit an archive's `type`/`category` carries. */
interface Coding {
  readonly system: string
  readonly code: string
}

/** The per-format data {@link sourceArchiveCodec} needs to build one format's archive codec. */
interface SourceArchiveConfig {
  /** The `type`/`category` coding that says "this is an archive of this format". */
  readonly coding: Coding
  /** The attachment's media type (`application/json` for HAR, `application/pdf` for LifeLabs). */
  readonly contentType: string
  /** Prefixed onto the file name for `DocumentReference.description` (`'HAR archive: '`). */
  readonly descriptionPrefix: string
  /**
   * The `securityLabel` codings, when the format carries one (HAR marks its
   * archive raw, the same as a trace). Omitted entirely when absent.
   */
  readonly securityLabel?: readonly Coding[] | undefined
  /** The schema `identifier` stem, e.g. `'HarArchive'` — the id and both directions name off it. */
  readonly archiveName: string
  /** A one-line description of the archive, e.g. `'One uploaded HAR file'`. */
  readonly label: string
  /** The `description` annotation for the archive-id refinement schema. */
  readonly idDescription: string
}

/** One uploaded source file: the bytes verbatim, plus who/when this system received it. */
interface SourceArchive {
  readonly id: string
  readonly fileName: string
  readonly uploadedAt: DateTime.Utc
  readonly bytes: Uint8Array
}

/** The wire (encoded) shape of a {@link SourceArchive} — every field a base64/ISO string. */
interface SourceArchiveEncoded {
  readonly id: string
  readonly fileName: string
  readonly uploadedAt: string
  readonly bytes: string
}

/** The codec {@link sourceArchiveCodec} returns for one format. */
interface SourceArchiveCodec {
  /** The decoded-side schema: `{ id, fileName, uploadedAt, bytes }`. */
  readonly Archive: Schema.Schema<SourceArchive, SourceArchiveEncoded>
  /** The FHIR resource id refinement — matches the id `sourceArchive` derives. */
  readonly ArchiveId: Schema.Schema<string, string>
  /** The encoding as one schema: a decoded `DocumentReference` on the encoded side. */
  readonly ArchiveFromDocumentReference: Schema.Schema<SourceArchive, DocumentReferenceType>
  /** The same encoding, reading from raw FHIR JSON. */
  readonly ArchiveFromFhirJson: Schema.Schema<SourceArchive, FhirR4.DocumentReference>
  /** `Schema.encode` of {@link ArchiveFromDocumentReference} — an archive to a decoded resource. */
  readonly archiveToDocumentReference: (
    archive: SourceArchive
  ) => Effect.Effect<DocumentReferenceType, ParseResult.ParseError>
  /** `Schema.decode` of {@link ArchiveFromDocumentReference} — a decoded resource back to its archive. */
  readonly archiveFromDocumentReference: (
    resource: DocumentReferenceType
  ) => Effect.Effect<SourceArchive, ParseResult.ParseError>
  /** The pure wire builder — an archive plus its precomputed hash to a `DocumentReference` object. */
  readonly toWire: (archive: SourceArchive, hash: string) => FhirR4.DocumentReference
  /** Whether a decoded `DocumentReference` is an archive of this format, by `category`. */
  readonly isArchive: (resource: DocumentReferenceType) => boolean
  /** The `system|code` `category` search token every server-side read filters on. */
  readonly categoryToken: string
  /**
   * Mint a picked file's archive resource: a deterministic id (from the bytes'
   * SHA-256 and the file name), the upload instant, and the encoded
   * `DocumentReference`. The descriptor's `sourceArchive` — pure, writes
   * nothing. Fails only as a `ParseError` (a digest unavailable in an insecure
   * context).
   */
  readonly sourceArchive: (picked: {
    readonly fileName: string
    readonly bytes: Uint8Array
  }) => Effect.Effect<DocumentReferenceType, ParseResult.ParseError>
}

/**
 * Build one format's source-archive codec from its coding and content type.
 *
 * @param config - The per-format coding, content type, description prefix, and
 *   optional security label — everything that differs between formats
 * @returns The codec: the `Archive` schema and its `ArchiveId` refinement, both
 *   directions (`ArchiveFromDocumentReference` / `ArchiveFromFhirJson` and their
 *   `encode`/`decode`), the pure `toWire` builder, `isArchive`, and the
 *   `categoryToken`
 */
const sourceArchiveCodec = (config: SourceArchiveConfig): SourceArchiveCodec => {
  const { coding, contentType, descriptionPrefix, securityLabel } = config

  const ArchiveId = Schema.NonEmptyString.pipe(
    Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/u)
  ).annotations({ identifier: `${config.archiveName}Id`, description: config.idDescription })

  const Archive = Schema.Struct({
    id: ArchiveId,
    fileName: Schema.NonEmptyString,
    uploadedAt: Schema.DateTimeUtc,
    bytes: Schema.Uint8ArrayFromBase64,
  })

  // The `ParseResult.*` variants (rather than `Schema.*`) fail with a bare
  // `ParseIssue`, which is what a `transformOrFail` step has to return.
  const decodeResource = ParseResult.decodeUnknown(DocumentReference.Schema)
  const encodeResource = ParseResult.encode(DocumentReference.Schema)
  const decodeArchive = ParseResult.decodeUnknown(Archive)

  const toWire = (archive: SourceArchive, hash: string): FhirR4.DocumentReference => {
    const uploadedAt = DateTime.formatIso(archive.uploadedAt)
    return {
      resourceType: 'DocumentReference',
      id: archive.id,
      status: 'current',
      type: { coding: [{ system: coding.system, code: coding.code }] },
      category: [{ coding: [{ system: coding.system, code: coding.code }] }],
      date: uploadedAt,
      description: `${descriptionPrefix}${archive.fileName}`,
      ...(securityLabel === undefined
        ? {}
        : { securityLabel: [{ coding: securityLabel.map((one) => ({ ...one })) }] }),
      content: [
        {
          attachment: {
            contentType,
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

  /** Whether a `CodeableConcept`-shaped value carries this format's archive coding. */
  const hasArchiveCoding = (concept: FhirR4.CodeableConcept | undefined): boolean =>
    (concept?.coding ?? []).some((one) => one.system === coding.system && one.code === coding.code)

  /** Read the archive out of a wire resource, or name the first thing it does not carry. */
  const readEncodedArchive = (wire: FhirR4.DocumentReference): Either.Either<unknown, string> => {
    if (!hasArchiveCoding(wire.type) || !(wire.category ?? []).some(hasArchiveCoding)) {
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

  const ArchiveFromDocumentReference: Schema.Schema<SourceArchive, DocumentReferenceType> =
    Schema.transformOrFail(
      Schema.typeSchema(DocumentReference.Schema),
      Schema.typeSchema(Archive),
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
            Effect.flatMap((hash) => decodeResource(toWire(archive, hash)))
          ),
      }
    ).annotations({
      identifier: `${config.archiveName}FromDocumentReference`,
      description: `${config.label}, encoded as a FHIR R4 DocumentReference.`,
    })

  const ArchiveFromFhirJson: Schema.Schema<SourceArchive, FhirR4.DocumentReference> =
    Schema.compose(DocumentReference.Schema, ArchiveFromDocumentReference).annotations({
      identifier: `${config.archiveName}FromFhirJson`,
      description: `${config.label}, encoded as FHIR R4 DocumentReference JSON.`,
    })

  const isArchive = (resource: DocumentReferenceType): boolean =>
    resource.category.some((category) =>
      category.coding.some(
        (one) => one.system?.toString() === coding.system && one.code === coding.code
      )
    )

  const sourceArchive = (picked: {
    readonly fileName: string
    readonly bytes: Uint8Array
  }): Effect.Effect<DocumentReferenceType, ParseResult.ParseError> =>
    Effect.gen(function* () {
      // A fresh `ArrayBuffer`-backed view: `crypto.subtle.digest` requires one,
      // and the same digest is the attachment `hash` `toWire` stamps below —
      // computed once and reused, not hashed twice.
      const bytes = new Uint8Array(picked.bytes)
      const hash = yield* sha256Base64(bytes).pipe(
        Effect.mapError((error) =>
          ParseResult.parseError(new ParseResult.Type(Archive.ast, picked, error.reason))
        )
      )
      const uploadedAt = yield* DateTime.now
      // Deterministic in the bytes and the name, so re-importing the same file
      // is the same document (overwrites, never duplicates). Namespaced under
      // the format's coding system, so a HAR and a PDF archive can never
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
        toWire({ id, fileName: picked.fileName, uploadedAt, bytes }, hash)
      ).pipe(Effect.mapError(ParseResult.parseError))
    })

  return {
    Archive,
    ArchiveId,
    ArchiveFromDocumentReference,
    ArchiveFromFhirJson,
    archiveToDocumentReference: Schema.encode(ArchiveFromDocumentReference),
    archiveFromDocumentReference: Schema.decode(ArchiveFromDocumentReference),
    toWire,
    isArchive,
    categoryToken: `${coding.system}|${coding.code}`,
    sourceArchive,
  }
}

export { type SourceArchive, type SourceArchiveCodec, type SourceArchiveConfig, sourceArchiveCodec }
