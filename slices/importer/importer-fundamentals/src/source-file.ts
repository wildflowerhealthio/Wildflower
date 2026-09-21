/**
 * The source file every format binding stores its upload as: the value, the
 * coding constants one format tags it with, and the schemas that turn it into
 * the FHIR `DocumentReference` it is stored as — and back.
 *
 * @remarks
 * The codec is written once here rather than per format, and the per-format
 * constants reach it as a {@link Format} service: the schemas carry that
 * requirement in their `R`, and the two places that discharge it are
 * `DecodeFunction.make` (for everything a decode mints) and the shell's reads
 * of the server's source-file list.
 *
 * `Reference` is the slice's one currency for "which source file", and is
 * deliberately cheap — `picked-file-source.ts` and `meta-source.ts` name one
 * without pulling a schema or the digest in behind it.
 *
 * @packageDocumentation
 */

import {
  Context,
  DateTime,
  Effect,
  Encoding,
  Option,
  ParseResult,
  Schema,
  Array as Arr,
} from 'effect'
import { joinIdComponents, localResourceId } from 'fhir-r4/identity'
import { DocumentReference } from 'fhir-r4/resources'
import type * as FhirR4 from 'fhir/r4.d.ts'

import type * as PickedFile from './picked-file.ts'
import { sha256Base64 } from './sha256.ts'

/** A resource a stored source file points at — one FHIR reference string. */
interface Subject {
  readonly reference: string
}

/**
 * One uploaded source file: its id, name, upload instant and bytes, plus the
 * links the stored archive carries.
 *
 * @remarks
 * The links are data on the value rather than a parameter of the encode,
 * because a stored archive really does carry them: reading one back yields
 * what is written there, and writing one back writes what was read.
 */
interface Type {
  readonly id: string
  readonly fileName: string
  readonly uploadedAt: DateTime.Utc
  readonly bytes: Uint8Array
  /** `DocumentReference.subject` — whose record the archive is in. */
  readonly subject: Option.Option<Subject>
  /** `DocumentReference.context.related` — the resources it is a source of. */
  readonly related: readonly Subject[]
}

/** A `system`/`code` pair — the axis one format's source files are tagged on. */
interface Coding {
  readonly system: string
  readonly code: string
}

/**
 * The per-format constants the schemas are parameterised by: which coding a
 * source file is tagged with, what its attachment claims to be, and how its
 * description reads.
 */
interface FormatValue {
  readonly coding: Coding
  readonly contentType: string
  readonly securityLabel?: readonly Coding[] | undefined
  readonly descriptionPrefix: string
}

/**
 * One format's {@link FormatValue}, as the service the schemas here require.
 *
 * @remarks
 * `DecodeFunction.make` provides it around everything one format's decode
 * mints, and the shell provides it at its two reads of a stored source file.
 * No other production code does — which is what keeps the constants an
 * importer lists and the constants its archives are written under the same
 * copy.
 */
class Format extends Context.Tag('importer-fundamentals/SourceFile.Format')<
  Format,
  FormatValue
>() {}

const REFERENCE_PREFIX = 'DocumentReference/'

/**
 * A typed FHIR reference to a source file's `DocumentReference`, carrying the
 * invariant that the string is `DocumentReference/<non-empty id>` at the type
 * level.
 */
type Reference = `DocumentReference/${string}`

const makeReference = (id: string): Reference => `${REFERENCE_PREFIX}${id}`

const idFromReference = (ref: Reference): string => ref.slice(REFERENCE_PREFIX.length)

/** The `system|code` search token one format's source files are found by. */
const categoryToken = (format: FormatValue): string =>
  `${format.coding.system}|${format.coding.code}`

/** Whether a `DocumentReference` off the server is one of this format's source files. */
const isSourceFile =
  (format: FormatValue) =>
  (resource: DocumentReference.Type): boolean =>
    resource.category.some((category) =>
      category.coding.some(
        (one) => one.system?.toString() === format.coding.system && one.code === format.coding.code
      )
    )

const IdSchema = Schema.NonEmptyString.pipe(Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/u)).annotations({
  identifier: `ImportSourceFileId`,
  description: `FHIR resource id of an uploaded source file; deterministic in the file hash and name.`,
})

const SubjectSchema = Schema.Struct({ reference: Schema.NonEmptyString })

/**
 * The source file as a value: what {@link FromDocumentReference} decodes to,
 * and the shape every field of it is validated against.
 */
const ValueSchema = Schema.Struct({
  id: IdSchema,
  fileName: Schema.NonEmptyString,
  uploadedAt: Schema.DateTimeUtcFromSelf,
  bytes: Schema.Uint8ArrayFromSelf,
  subject: Schema.OptionFromSelf(SubjectSchema),
  related: Schema.Array(SubjectSchema),
})

/** The fields a stored archive carries as strings, read back off its attachment. */
const StoredFieldsSchema = Schema.Struct({
  id: IdSchema,
  fileName: Schema.NonEmptyString,
  uploadedAt: Schema.DateTimeUtcFromSelf,
  bytes: Schema.Uint8ArrayFromBase64,
})

const decodeStoredFields = ParseResult.decodeUnknown(StoredFieldsSchema)

const decodeResource = ParseResult.decodeUnknown(DocumentReference.Schema)

/** A named blob of bytes, as the mint reads a picked file. */
const NamedBytesSchema = Schema.Struct({
  fileName: Schema.NonEmptyString,
  bytes: Schema.Uint8ArrayFromSelf,
})

const hasCoding = (
  concept: {
    readonly coding: readonly { readonly system: unknown; readonly code: string | null }[]
  } | null,
  coding: Coding
): boolean =>
  (concept?.coding ?? []).some(
    (one) => one.system?.toString() === coding.system && one.code === coding.code
  )

/**
 * Why this resource is not one of the format's source files, or `undefined`
 * when it is one.
 *
 * @remarks
 * Every reason names the resource, so a failing list says which row it was —
 * the schema's own issue carries the message, rather than a caller assembling
 * one.
 */
const rejection = (resource: DocumentReference.Type, coding: Coding): string | undefined => {
  const named = resource.id ?? '<no id>'
  if (!hasCoding(resource.type, coding) || !resource.category.some((one) => hasCoding(one, coding)))
    return `${named}: Not a ${coding.code} document`
  const attachment = resource.content[0]?.attachment
  if (attachment === undefined) return `${named}: No content entry`
  if (attachment.data === null) return `${named}: Attachment carries no data`
  return undefined
}

const isArchive = Schema.is(Schema.typeSchema(DocumentReference.Schema))

/**
 * A decoded `DocumentReference`, as itself.
 *
 * @remarks
 * Declared rather than `Schema.typeSchema(DocumentReference.Schema)`, whose
 * encode walks the struct and drops a `null` optional to `undefined` — writing
 * back a resource that no longer matches the type it claims. A declaration's
 * encode is the identity, so what {@link FromDocumentReference} builds is
 * exactly what it yields.
 */
const ArchiveSchema: Schema.Schema<DocumentReference.Type> = Schema.declare(
  (input: unknown): input is DocumentReference.Type => isArchive(input)
)

/** A `DocumentReference` that is one of this format's source files, data and all. */
const ArchiveOfFormat = ArchiveSchema.pipe(
  Schema.filterEffect((resource) => Effect.map(Format, ({ coding }) => rejection(resource, coding)))
)

const subjectOf = (
  reference: { readonly reference: string | null } | null
): Option.Option<Subject> =>
  Option.map(Option.fromNullable(reference?.reference), (one): Subject => ({ reference: one }))

/** The archive's own links, as the value carries them. */
const linksOf = (resource: DocumentReference.Type): Pick<Type, 'subject' | 'related'> => ({
  subject: subjectOf(resource.subject),
  related: Arr.filterMap(resource.context?.related ?? [], (one) => subjectOf(one)),
})

const wireOf = (sourceFile: Type, hash: string, format: FormatValue): FhirR4.DocumentReference => {
  const { coding, contentType, securityLabel, descriptionPrefix } = format
  const uploadedAt = DateTime.formatIso(sourceFile.uploadedAt)
  return {
    resourceType: 'DocumentReference',
    id: sourceFile.id,
    status: 'current',
    type: { coding: [{ system: coding.system, code: coding.code }] },
    category: [{ coding: [{ system: coding.system, code: coding.code }] }],
    date: uploadedAt,
    description: `${descriptionPrefix}${sourceFile.fileName}`,
    ...Option.match(sourceFile.subject, {
      onNone: () => ({}),
      onSome: (subject) => ({ subject: { ...subject } }),
    }),
    ...(sourceFile.related.length === 0
      ? {}
      : { context: { related: sourceFile.related.map((one) => ({ ...one })) } }),
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

/** Hash the bytes and build the archive the source file is stored as. */
const toArchive = (
  sourceFile: Type,
  ast: Schema.Schema.AnyNoContext['ast']
): Effect.Effect<DocumentReference.Type, ParseResult.ParseIssue, Format> =>
  Effect.gen(function* () {
    const format = yield* Format
    const hash = yield* sha256Base64(new Uint8Array(sourceFile.bytes)).pipe(
      Effect.mapError((error) => new ParseResult.Type(ast, sourceFile, error.reason))
    )
    return yield* decodeResource(wireOf(sourceFile, hash, format))
  })

/**
 * The codec: one source file ⇄ the `DocumentReference` it is stored as.
 *
 * @remarks
 * The read leg accepts only an archive of this format carrying attachment
 * data — {@link ArchiveOfFormat} — and then projects it; the write leg hashes
 * the bytes into the attachment's `hash` and writes the value's own
 * `subject` and `related`.
 */
const FromDocumentReference: Schema.Schema<Type, DocumentReference.Type, Format> =
  Schema.transformOrFail(ArchiveOfFormat, ValueSchema, {
    strict: true,
    decode: (resource) => {
      const attachment = resource.content[0]?.attachment
      return Effect.map(
        decodeStoredFields({
          id: resource.id,
          fileName: attachment?.title,
          uploadedAt: attachment?.creation ?? resource.date,
          bytes: attachment?.data,
        }),
        (stored): Type => ({ ...stored, ...linksOf(resource) })
      )
    },
    encode: (sourceFile, _options, ast) => toArchive(sourceFile, ast),
  }).annotations({
    identifier: `SourceFileFromDocumentReference`,
    description: `One uploaded source file, encoded as a FHIR R4 DocumentReference.`,
  })

/**
 * Decide a picked file's source file: its deterministic id, its name, the
 * instant it was taken in, and no links yet.
 *
 * @remarks
 * The id is a SHA-256 of the bytes plus the file name, namespaced by the
 * format's coding system, so re-importing the same file upserts rather than
 * duplicating and two formats never collide on identical bytes. What the
 * archive links to is not knowable here — a decode names it afterwards, off
 * the resources it read.
 */
const mint = (
  picked: PickedFile.NamedBytes,
  ast: Schema.Schema.AnyNoContext['ast']
): Effect.Effect<Type, ParseResult.ParseIssue, Format> =>
  Effect.gen(function* () {
    const { coding } = yield* Format
    const bytes = new Uint8Array(picked.bytes)
    const hash = yield* sha256Base64(bytes).pipe(
      Effect.mapError((error) => new ParseResult.Type(ast, picked, error.reason))
    )
    const uploadedAt = yield* DateTime.now
    const id = localResourceId(
      coding.system,
      'DocumentReference',
      joinIdComponents([hash, picked.fileName])
    )
    return { id, fileName: picked.fileName, uploadedAt, bytes, subject: Option.none(), related: [] }
  })

const namedBytesOf = (sourceFile: Type): PickedFile.NamedBytes => ({
  fileName: sourceFile.fileName,
  bytes: sourceFile.bytes,
})

/**
 * The mint, as a schema: decoding a picked file's name and bytes hashes,
 * clocks and ids them into a source file; encoding drops back to the name and
 * the bytes.
 */
const FromNamedBytes: Schema.Schema<Type, PickedFile.NamedBytes, Format> = Schema.transformOrFail(
  NamedBytesSchema,
  ValueSchema,
  {
    strict: true,
    decode: (picked, _options, ast) => mint(picked, ast),
    encode: (sourceFile) => ParseResult.succeed(namedBytesOf(sourceFile)),
  }
).annotations({
  identifier: `SourceFileFromNamedBytes`,
  description: `A picked file's name and bytes, minted into the source file they are stored as.`,
})

/** {@link FromNamedBytes} the other way round, so the read below composes. */
const NamedBytesFromSourceFile: Schema.Schema<PickedFile.NamedBytes, Type, Format> =
  Schema.transformOrFail(ValueSchema, NamedBytesSchema, {
    strict: true,
    decode: (sourceFile) => ParseResult.succeed(namedBytesOf(sourceFile)),
    encode: (picked, _options, ast) => mint(picked, ast),
  })

/**
 * What the preview dialog reads: a stored archive's file name and raw bytes,
 * in one decode.
 */
const NamedBytesFromDocumentReference: Schema.Schema<
  PickedFile.NamedBytes,
  DocumentReference.Type,
  Format
> = Schema.compose(FromDocumentReference, NamedBytesFromSourceFile)

export {
  Format,
  FromDocumentReference,
  FromNamedBytes,
  NamedBytesFromDocumentReference,
  categoryToken,
  idFromReference,
  isSourceFile,
  makeReference,
}
export type { Coding, FormatValue, Reference, Subject, Type }
