/**
 * The source-file vocabulary every format binding shares — and the codec that
 * turns a source file into the FHIR `DocumentReference` it is stored as, and
 * back.
 *
 * @remarks
 * `Reference` is the single currency for "which source file": a `server` pick
 * already carries one, a `local` pick's mint produces an id `makeReference`
 * wraps, and `idFromReference` is for the one format (DICOM) that needs the
 * bare id to build a resource link out of.
 *
 * The codec — `tryFromNamedBytes`, `encode`, `decode` — is written once here
 * rather than per format, parameterised by the {@link FormatContext} a format's
 * coding constants supply. `FileImporter.make` is the only place that binds
 * that context; see `file-importer.ts`.
 *
 * @packageDocumentation
 */

import {
  Context,
  DateTime,
  Effect,
  Either,
  Encoding,
  ParseResult,
  Schema,
  pipe,
  type SchemaAST,
} from 'effect'
import { joinIdComponents, localResourceId } from 'fhir-r4/identity'
import { DocumentReference } from 'fhir-r4/resources'
import type * as FhirR4 from 'fhir/r4.d.ts'
import type * as DecodedFile from './decoded-file.ts'
import type * as PickedFile from './picked-file.ts'
import { sha256Base64 } from './sha256.ts'

type DocumentReferenceType = typeof DocumentReference.Schema.Type

// ─── Source File ────────────────────────────────────────────────────────────

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
type SubjectFor = (file: PickedFile.Type, decoded: DecodedFile.DecodedFile) => Subject | undefined

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

// ─── Codec ──────────────────────────────────────────────────────────────────

const IdSchema = Schema.NonEmptyString.pipe(Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/u)).annotations({
  identifier: `ImportSourceFileId`,
  description: `FHIR resource id of an uploaded source file; deterministic in the file hash and name.`,
})

const SourceFileSchema = Schema.Struct({
  id: IdSchema,
  fileName: Schema.NonEmptyString,
  uploadedAt: Schema.DateTimeUtc,
  bytes: Schema.Uint8ArrayFromBase64,
})

type Encoded = typeof SourceFileSchema.Encoded

/**
 * A source file's fields as a `DocumentReference` carries them: every one
 * optional there, every one required by the schema they are validated against.
 */
type PartialEncoded = { readonly [K in keyof Encoded]: Encoded[K] | undefined }

const decodeParts: (parts: PartialEncoded) => Effect.Effect<Type, ParseResult.ParseIssue> =
  ParseResult.decodeUnknown(SourceFileSchema)

const decodeResource = ParseResult.decodeUnknown(DocumentReference.Schema)

/**
 * The per-format constants the codec above is parameterised by: which coding a
 * source file is tagged with, what its attachment claims to be, and how its
 * description reads.
 *
 * @remarks
 * `fileImporter` builds one of these from a binding's config and provides it at
 * the boundary, so no `FileImporter` member — and nothing above this package —
 * ever carries the requirement. It is also the one thing a `FileImporter`
 * carries as data (`sourceFileFormat`), which is how a binding's test drives
 * the codec below under the format's real config rather than restating it.
 */
interface Format {
  readonly coding: Coding
  readonly contentType: string
  readonly securityLabel?: readonly Coding[] | undefined
  readonly descriptionPrefix: string
}

class FormatContext extends Context.Tag('SourceFileFormatContext')<FormatContext, Format>() {}

const toWire = ({
  sourceFile,
  hash,
  subject,
}: {
  readonly sourceFile: Type
  readonly hash: string
  readonly subject: Subject | undefined
}): Effect.Effect<FhirR4.DocumentReference, never, FormatContext> =>
  Effect.map(FormatContext, ({ coding, contentType, securityLabel, descriptionPrefix }) => {
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
  })

/**
 * Hash the bytes and build the source file's `DocumentReference`.
 *
 * @remarks
 * The private half of {@link encode}: it takes the `ast` to blame, so its two
 * callers — {@link encode} and the schema transform's own `encode` — each
 * report a digest failure against the schema they were working in.
 *
 * @param sourceFile - The minted source file to store
 * @param subject - The subject to file it under, when the format names one
 * @param ast - The schema to blame for a failure
 * @returns The source file's `DocumentReference`
 */
const hashAndBuild = (
  sourceFile: Type,
  subject: Subject | undefined,
  ast: SchemaAST.AST
): Effect.Effect<DocumentReferenceType, ParseResult.ParseIssue, FormatContext> =>
  sha256Base64(new Uint8Array(sourceFile.bytes)).pipe(
    Effect.mapError((error) => new ParseResult.Type(ast, sourceFile, error.reason)),
    Effect.flatMap((hash) => toWire({ sourceFile, hash, subject })),
    Effect.flatMap(decodeResource)
  )

const hasCoding = (concept: FhirR4.CodeableConcept | undefined, coding: Coding): boolean =>
  (concept?.coding ?? []).some((one) => one.system === coding.system && one.code === coding.code)

const readParts = (
  wire: FhirR4.DocumentReference,
  coding: Coding
): Either.Either<PartialEncoded, string> => {
  if (
    !hasCoding(wire.type, coding) ||
    !(wire.category ?? []).some((one) => hasCoding(one, coding))
  ) {
    return Either.left(`Not a ${coding.code} document`)
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
 * Read a stored `DocumentReference` back into a source file — the mirror of
 * {@link hashAndBuild}, and like it blaming the `ast` the caller was working in.
 *
 * @param wire - The stored resource, as wire JSON
 * @param ast - The schema to blame for a failure
 * @returns The source file, or a failure naming the resource and the reason
 */
const decode = (
  wire: FhirR4.DocumentReference,
  ast: SchemaAST.AST
): Effect.Effect<Type, ParseResult.ParseIssue, FormatContext> =>
  Effect.flatMap(FormatContext, ({ coding }) =>
    Either.match(readParts(wire, coding), {
      onLeft: (reason) =>
        Effect.fail(new ParseResult.Type(ast, wire, `${wire.id ?? '<no id>'}: ${reason}`)),
      onRight: decodeParts,
    })
  )

/**
 * Decide a picked file's source file: its deterministic id, its name, and the
 * instant it was taken in.
 *
 * @remarks
 * The id is a SHA-256 of the bytes plus the file name, namespaced by the
 * format's coding system, so re-importing the same file upserts rather than
 * duplicating and two formats never collide on identical bytes.
 *
 * @param picked - The picked file's name and bytes
 * @returns The minted source file
 */
const tryFromNamedBytes = (
  picked: PickedFile.NamedBytes
): Effect.Effect<Type, ParseResult.ParseError, FormatContext> =>
  Effect.gen(function* () {
    const { coding } = yield* FormatContext
    const bytes = new Uint8Array(picked.bytes)
    const hash = yield* sha256Base64(bytes).pipe(
      Effect.mapError((error) =>
        ParseResult.parseError(new ParseResult.Type(SourceFileSchema.ast, picked, error.reason))
      )
    )
    const uploadedAt = yield* DateTime.now
    const id = localResourceId(
      coding.system,
      'DocumentReference',
      joinIdComponents([hash, picked.fileName])
    )
    return { id, fileName: picked.fileName, uploadedAt, bytes }
  })

const encodeResource = ParseResult.encode(DocumentReference.Schema)

const FromDocumentReferenceSchema: Schema.Schema<Type, DocumentReferenceType, FormatContext> =
  Schema.transformOrFail(
    Schema.typeSchema(DocumentReference.Schema),
    Schema.typeSchema(SourceFileSchema),
    {
      strict: true,
      decode: (resource, _options, ast) =>
        pipe(
          encodeResource(resource),
          Effect.flatMap((wire) => decode(wire, ast))
        ),
      encode: (sourceFile, _options, ast) => hashAndBuild(sourceFile, undefined, ast),
    }
  ).annotations({
    identifier: `SourceFileFromDocumentReference`,
    description: `One uploaded source file, encoded as a FHIR R4 DocumentReference.`,
  })

const validateSourceFile = ParseResult.validate(Schema.typeSchema(SourceFileSchema))

/**
 * Encode a source file as the `DocumentReference` it is stored as — the
 * public mirror of {@link decode}.
 *
 * @param sourceFile - The minted source file to store
 * @param subject - The subject to file it under, when the format names one
 * @returns The source file's `DocumentReference`
 */
const encode = (
  sourceFile: Type,
  subject?: Subject
): Effect.Effect<DocumentReferenceType, ParseResult.ParseError, FormatContext> =>
  validateSourceFile(sourceFile).pipe(
    Effect.flatMap((valid) => hashAndBuild(valid, subject, FromDocumentReferenceSchema.ast)),
    Effect.mapError(ParseResult.parseError)
  )

/**
 * Mint a picked file's source file and encode it, in one step —
 * {@link tryFromNamedBytes} then {@link encode}.
 *
 * @remarks
 * Named for its *result*: unlike `tryFromNamedBytes`, which yields a
 * {@link Type}, this yields the stored resource. The batch decode does the two
 * steps separately, because it can only name the subject once the file's
 * decode has run.
 *
 * @param picked - The picked file's name and bytes
 * @param subject - The subject to file it under, when the format names one
 * @returns The source file's `DocumentReference`
 */
const mintResource = (
  picked: PickedFile.NamedBytes,
  subject?: Subject
): Effect.Effect<DocumentReferenceType, ParseResult.ParseError, FormatContext> =>
  tryFromNamedBytes(picked).pipe(Effect.flatMap((sourceFile) => encode(sourceFile, subject)))

const inFormatsCategory = (
  documentReference: DocumentReferenceType
): Effect.Effect<boolean, never, FormatContext> =>
  Effect.map(FormatContext, ({ coding }) =>
    documentReference.category.some((category) =>
      category.coding.some(
        (one) => one.system?.toString() === coding.system && one.code === coding.code
      )
    )
  )

const categoryToken = Effect.map(FormatContext, ({ coding }) => `${coding.system}|${coding.code}`)

export {
  SECTION_TITLE,
  FormatContext,
  categoryToken,
  decode,
  encode,
  idFromReference,
  inFormatsCategory,
  key,
  makeReference,
  mintResource,
  prependToDecodedFile,
  tryFromNamedBytes,
  FromDocumentReferenceSchema,
  SourceFileSchema as Schema,
}
export type { Coding, Format, PerFileDecodeOptions, Reference, Subject, SubjectFor, Type }
