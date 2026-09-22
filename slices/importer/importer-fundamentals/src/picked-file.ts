/**
 * The one value every picker source converges on and every format's `decode`
 * receives — a file's id, its name and its raw bytes — together with the
 * coding constants one format tags its archives with and the codec that stores
 * a pick as the FHIR `DocumentReference` it is archived as, and reads it back.
 *
 * @remarks
 * Bytes rather than text so the picker stays format-blind: a HAR decodes
 * UTF-8 JSON, a PDF decodes binary. The id is minted once, where the batch is
 * read (`importer-core`'s `readBatch`), so everything keyed by it survives a
 * settings re-decode, which hands the same files back.
 *
 * The codec is written once here rather than per format, and the per-format
 * constants reach it as a {@link Format} service: {@link FromDocumentReference}
 * carries that requirement in its `R`, and the two places that discharge it are
 * `DecodeFunction.make` (for everything a decode mints) and the shell's read of
 * the server's source-file list.
 *
 * @packageDocumentation
 */

import { Context, Effect, Encoding, ParseResult, Schema } from 'effect'
import { joinIdComponents, localResourceId } from 'fhir-r4/identity'
import { DocumentReference } from 'fhir-r4/resources'
import type * as FhirR4 from 'fhir/r4.d.ts'

import { sha256Base64 } from './sha256.ts'

/**
 * A named blob of bytes — the part of a {@link Type | picked file} that a step
 * which does not yet have an id for it holds.
 *
 * @remarks
 * Named so every picker source (the local file picker, the server list's
 * fetch), `FormatDetector.claiming` and the archive's own mint all spell one
 * shape instead of three structural copies of it.
 */
interface NamedBytes {
  /** The file's name, for display and for the archive's attachment title. */
  readonly fileName: string
  /** The file's raw bytes, exactly as they were read. */
  readonly bytes: Uint8Array
}

/**
 * A file chosen from one of the picker's sources, with the id its batch gave
 * it.
 *
 * @remarks
 * The id is assigned in exactly one place — `importer-core`'s `readBatch`,
 * over the whole batch in pick order — so every review key, result id and
 * unreadable row derived from it is stable across a settings re-decode.
 */
interface Type extends NamedBytes {
  /** Distinguishes this pick from every other in the batch it was read in. */
  readonly id: string
}

/** A `system`/`code` pair — the axis one format's archives are tagged on. */
interface Coding {
  readonly system: string
  readonly code: string
}

/**
 * The per-format constants the codec is parameterised by: which coding an
 * archive is tagged with, what its attachment claims to be, and how its
 * description reads.
 */
interface FormatValue {
  readonly coding: Coding
  readonly contentType: string
  readonly securityLabel?: readonly Coding[] | undefined
  readonly descriptionPrefix: string
}

/**
 * One format's {@link FormatValue}, as the service {@link FromDocumentReference}
 * requires.
 *
 * @remarks
 * `DecodeFunction.make` provides it around everything one format's decode
 * mints, and the shell provides it at its read of a stored archive. No other
 * production code does — which is what keeps the constants an importer lists
 * and the constants its archives are written under the same copy.
 */
class Format extends Context.Tag('importer-fundamentals/PickedFile.Format')<
  Format,
  FormatValue
>() {}

/** The `system|code` search token one format's archives are found by. */
const categoryToken = (format: FormatValue): string =>
  `${format.coding.system}|${format.coding.code}`

/** Whether a `DocumentReference` off the server is one of this format's archives. */
const isSourceFile =
  (format: FormatValue) =>
  (resource: DocumentReference.Type): boolean =>
    resource.category.some((category) =>
      category.coding.some(
        (one) => one.system?.toString() === format.coding.system && one.code === format.coding.code
      )
    )

const IdSchema = Schema.NonEmptyString.pipe(Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/u)).annotations({
  identifier: `ImportPickedFileId`,
  description: `FHIR resource id of an archived pick; deterministic in the file hash and name.`,
})

/**
 * The picked file as a value: what {@link FromDocumentReference} decodes to,
 * and the shape every field of it is validated against.
 */
const ValueSchema = Schema.Struct({
  // A plain string, not {@link IdSchema}: a picked file's id is the batch slot
  // `readBatch` stamped it with (`0:report.pdf`), which the mint ignores — only
  // an id *read back off a stored archive* is a FHIR resource id.
  id: Schema.NonEmptyString,
  fileName: Schema.NonEmptyString,
  bytes: Schema.Uint8ArrayFromSelf,
})

/** The fields a stored archive carries as strings, read back off its attachment. */
const StoredFieldsSchema = Schema.Struct({
  id: IdSchema,
  fileName: Schema.NonEmptyString,
  bytes: Schema.Uint8ArrayFromBase64,
})

const decodeStoredFields = ParseResult.decodeUnknown(StoredFieldsSchema)

const decodeResource = ParseResult.decodeUnknown(DocumentReference.Schema)

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
 * Why this resource is not one of the format's archives, or `undefined` when it
 * is one.
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

/** A `DocumentReference` that is one of this format's archives, data and all. */
const ArchiveOfFormat = ArchiveSchema.pipe(
  Schema.filterEffect((resource) => Effect.map(Format, ({ coding }) => rejection(resource, coding)))
)

/**
 * The archive a pick is stored as, on the wire.
 *
 * @remarks
 * No instant of any kind: the archive states what the file *is*, not when it
 * reached the device, and the stored resource's own `meta.lastUpdated` is what
 * the server list dates a row by.
 */
const wireOf = (
  id: string,
  picked: NamedBytes,
  hash: string,
  format: FormatValue
): FhirR4.DocumentReference => {
  const { coding, contentType, securityLabel, descriptionPrefix } = format
  return {
    resourceType: 'DocumentReference',
    id,
    status: 'current',
    type: { coding: [{ system: coding.system, code: coding.code }] },
    category: [{ coding: [{ system: coding.system, code: coding.code }] }],
    description: `${descriptionPrefix}${picked.fileName}`,
    ...(securityLabel === undefined
      ? {}
      : { securityLabel: [{ coding: securityLabel.map((one) => ({ ...one })) }] }),
    content: [
      {
        attachment: {
          contentType,
          data: Encoding.encodeBase64(picked.bytes),
          size: picked.bytes.length,
          hash,
          title: picked.fileName,
        },
      },
    ],
  }
}

/**
 * Mint the archive a picked file is stored as: hash its bytes, decide its id,
 * and build the resource.
 *
 * @remarks
 * The id is a SHA-256 of the bytes plus the file name, namespaced by the
 * format's coding system, so re-importing the same file upserts rather than
 * duplicating and two formats never collide on identical bytes. The value's
 * own `id` — the batch slot the pick was read in — takes no part in it: the
 * mint decides the archive's id, and reading the archive back yields that one.
 */
const toArchive = (
  picked: NamedBytes,
  ast: Schema.Schema.AnyNoContext['ast']
): Effect.Effect<DocumentReference.Type, ParseResult.ParseIssue, Format> =>
  Effect.gen(function* () {
    const format = yield* Format
    const bytes = new Uint8Array(picked.bytes)
    const hash = yield* sha256Base64(bytes).pipe(
      Effect.mapError((error) => new ParseResult.Type(ast, picked, error.reason))
    )
    const id = localResourceId(
      format.coding.system,
      'DocumentReference',
      joinIdComponents([hash, picked.fileName])
    )
    return yield* decodeResource(wireOf(id, { ...picked, bytes }, hash, format))
  })

/**
 * The codec: one picked file ⇄ the `DocumentReference` it is archived as.
 *
 * @remarks
 * The read leg accepts only an archive of this format carrying attachment data
 * — {@link ArchiveOfFormat} — and then projects it, so the file read back
 * carries the stored resource's own id. The write leg mints: it hashes the
 * bytes into the attachment's `hash` and derives the archive's id from them,
 * ignoring the value's own id. Decoding an archive and encoding it again is
 * therefore the identity on the id.
 */
const FromDocumentReference: Schema.Schema<Type, DocumentReference.Type, Format> =
  Schema.transformOrFail(ArchiveOfFormat, ValueSchema, {
    strict: true,
    decode: (resource) => {
      const attachment = resource.content[0]?.attachment
      return decodeStoredFields({
        id: resource.id,
        fileName: attachment?.title,
        bytes: attachment?.data,
      })
    },
    encode: (picked, _options, ast) => toArchive(picked, ast),
  }).annotations({
    identifier: `PickedFileFromDocumentReference`,
    description: `One picked file, encoded as the FHIR R4 DocumentReference it is archived as.`,
  })

export { Format, FromDocumentReference, categoryToken, isSourceFile }
export type { Coding, FormatValue, NamedBytes, Type }
