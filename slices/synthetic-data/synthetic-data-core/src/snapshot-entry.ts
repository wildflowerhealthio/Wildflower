import { dicomImporter } from 'dicom-importer-core'
import { Array as Arr, Either, Encoding, ParseResult, Schema, Struct } from 'effect'
import { type DocumentReference, type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { harImporter } from 'har-importer-core'
import { PickedFile } from 'importer-fundamentals'

import * as SnapshotFile from './snapshot-file.ts'

/**
 * A snapshot's entries: each resource in the FHIR store, and each file an
 * importer read — a HAR, a DICOM image — that a source-file
 * `DocumentReference` among them stores.
 *
 * @remarks
 * Each entry kind owns its codec to and from the file it is stored as
 * ({@link FileSchema}): a {@link Resource} is FHIR R4 JSON at
 * `fhir/<ResourceType>/<id>.json`, an {@link Attachment} its bytes at
 * `<format>/<file name>` (`har/…`, `dicom/…`). The paths loosely follow FHIR
 * but a snapshot is not a FHIR server: a static host serves it, and its
 * header (`index.json`) lists what is in it, because a static host cannot
 * list a directory.
 *
 * An import stores the file it read inline, as the `data` of its source-file
 * `DocumentReference`'s attachment. In a snapshot that file is an
 * {@link Attachment} of its own, and the `DocumentReference`'s
 * {@link Resource} names it by `attachmentPath`: its attachment carries
 * neither `data` nor `url`, and its file carries the path, relative to the
 * snapshot's root, as `url`. `contentType`, `size`, `hash` and `title` stay
 * as the importer wrote them, and ids are kept, so every `meta.source` still
 * names its `DocumentReference`.
 */

/** The top-level directory every resource file sits under. */
const FHIR_DIRECTORY = 'fhir'

/**
 * The importers whose source files a snapshot carries as {@link Attachment}s.
 * Each one's `format` names the directory its files sit in, and its
 * `sourceFileFormat` coding is how its source-file `DocumentReference`s are
 * recognized (`PickedFile.isSourceFile`, as the importer's own source-file
 * list recognizes them).
 */
const SOURCE_FILE_IMPORTERS = [harImporter, dicomImporter] as const

/** The attachment formats, in {@link SOURCE_FILE_IMPORTERS}' order: `har`, `dicom`. */
const FORMATS = Arr.map(SOURCE_FILE_IMPORTERS, (importer) => importer.format)

/** An attachment's format: its importer's, and the directory its file sits in. */
const FormatSchema = Schema.Literal(...FORMATS)

type Format = typeof FormatSchema.Type

/** FHIR R4's `id` grammar. */
const FHIR_ID_PATTERN = '[A-Za-z0-9\\-.]{1,64}'

/**
 * The file names an attachment may have: a letter or digit, then letters,
 * digits, `.`, `_` or `-` — nothing a path or URL would read as a separator,
 * a parent directory or an escape.
 */
const FILE_NAME_PATTERN = '[A-Za-z0-9][A-Za-z0-9._\\-]{0,127}'

const FHIR_ID = new RegExp(`^${FHIR_ID_PATTERN}$`)

/** A resource id in FHIR R4's id grammar. */
const ResourceIdSchema = Schema.String.pipe(Schema.pattern(FHIR_ID)).annotations({
  identifier: 'SnapshotResourceId',
})

/** An attachment's file name: the source file's `title`, the name it was picked under. */
const FileNameSchema = Schema.String.pipe(
  Schema.pattern(new RegExp(`^${FILE_NAME_PATTERN}$`))
).annotations({ identifier: 'SnapshotFileName' })

/** A resource's path, as its file sits and the header lists it. */
const ResourcePathSchema = Schema.String.pipe(
  Schema.pattern(new RegExp(`^${FHIR_DIRECTORY}/[A-Z][A-Za-z]*/${FHIR_ID_PATTERN}\\.json$`))
).annotations({
  identifier: 'SnapshotResourcePath',
  description: 'A resource in a snapshot: fhir/<ResourceType>/<id>.json',
})

/**
 * An attachment's path, as its file sits, the header lists it and a source
 * file's `url` links to it.
 */
const AttachmentPathSchema = Schema.String.pipe(
  Schema.pattern(new RegExp(`^(?:${FORMATS.join('|')})/${FILE_NAME_PATTERN}$`))
).annotations({
  identifier: 'SnapshotAttachmentPath',
  description: `A file an importer read, in a snapshot: <${FORMATS.join('|')}>/<file name>`,
})

/** An attachment's path read as its format and file name. */
const AttachmentPathPartsSchema = Schema.compose(
  AttachmentPathSchema,
  Schema.TemplateLiteralParser(FormatSchema, '/', FileNameSchema),
  { strict: false }
)

/** `fhir/<resourceType>/<id>.json`, for an `id` in FHIR's id grammar. */
const resourcePathOf = (resourceType: FhirResource['resourceType'], id: string): string =>
  `${FHIR_DIRECTORY}/${resourceType}/${id}.json`

/** `<format>/<fileName>`, for a file name {@link FileNameSchema} accepts. */
const attachmentPathOf = (format: Format, fileName: string): string => `${format}/${fileName}`

/** A resource with an id in FHIR's id grammar, as a snapshot stores it. */
type StoredResource = FhirResource & { readonly id: string }

const StoredResourceSchema = Schema.typeSchema(FhirResourceSchema).pipe(
  Schema.filter((resource): resource is StoredResource => resource.id !== null, {
    message: () => 'A resource in a snapshot has an id.',
  }),
  Schema.filter((resource) => FHIR_ID.test(resource.id), {
    message: () => `A resource in a snapshot has an id in FHIR's id grammar (${FHIR_ID_PATTERN}).`,
  })
)

/**
 * Whether a resource is a `DocumentReference` whose one attachment carries
 * neither `data` nor `url`: what a {@link Resource} linking an
 * {@link Attachment} holds.
 */
const isUnlinkedSourceFile = (resource: FhirResource): boolean => {
  if (resource.resourceType !== 'DocumentReference') return false
  const [content, ...otherContent] = resource.content
  return (
    content !== undefined &&
    otherContent.length === 0 &&
    content.attachment.data === null &&
    content.attachment.url === null
  )
}

/** A resource in the store, as its import wrote it. */
const ResourceSchema = Schema.TaggedStruct('Resource', {
  resource: StoredResourceSchema,
  /**
   * For a source-file `DocumentReference`, the path of the {@link Attachment}
   * holding the file it read. Its one attachment then carries neither `data`
   * nor `url`; its file carries this path as `url`.
   */
  attachmentPath: Schema.optional(AttachmentPathSchema),
})
  .pipe(
    Schema.filter(
      ({ resource, attachmentPath }) =>
        attachmentPath === undefined ||
        isUnlinkedSourceFile(resource) ||
        'A resource linking an attachment is a DocumentReference whose one attachment carries neither data nor url.'
    )
  )
  .annotations({ identifier: 'SnapshotResourceEntry' })

/** A file an importer read, kept beside the resources it was read into. */
const AttachmentSchema = Schema.TaggedStruct('Attachment', {
  format: FormatSchema,
  /** The source file's `title`. */
  fileName: FileNameSchema,
  bytes: Schema.Uint8ArrayFromSelf,
}).annotations({ identifier: 'SnapshotAttachmentEntry' })

const AnySchema = Schema.Union(ResourceSchema, AttachmentSchema)

type Resource = typeof ResourceSchema.Type

type Attachment = typeof AttachmentSchema.Type

/** An entry of a snapshot: a resource, or a file an importer read. */
type Any = typeof AnySchema.Type

/** Where an entry's file sits, relative to the snapshot's root. */
const pathOf = (entry: Any): string =>
  entry._tag === 'Resource'
    ? resourcePathOf(entry.resource.resourceType, entry.resource.id)
    : attachmentPathOf(entry.format, entry.fileName)

/** A resource as its file holds it: the FHIR R4 JSON its schema encodes it to. */
type ResourceJson = Schema.Schema.Encoded<typeof FhirResourceSchema>

type DocumentReferenceJson = Extract<ResourceJson, { readonly resourceType: 'DocumentReference' }>

/**
 * A resource file's JSON, checked for shape but not read into `fhir-r4`'s
 * decoded values, so a linked source file's relative `url` decodes
 * (`FhirResourceSchema` reads a `url` as an absolute `URL`).
 */
const ResourceJsonSchema: Schema.Schema<ResourceJson> = Schema.encodedSchema(FhirResourceSchema)

const isAttachmentPath = Schema.is(AttachmentPathSchema)

/**
 * The attachment a resource file's JSON links to, or `undefined` when it is
 * not a linked source file: a `DocumentReference` whose one attachment
 * carries an {@link AttachmentPathSchema} `url` and no `data`.
 */
const attachmentPathLinkedBy = (json: ResourceJson): string | undefined => {
  if (json.resourceType !== 'DocumentReference') return undefined
  const [content, ...otherContent] = json.content
  if (content === undefined || otherContent.length > 0) return undefined
  const { url, data } = content.attachment
  return url !== undefined && data === undefined && isAttachmentPath(url) ? url : undefined
}

/**
 * A source file's JSON with its attachment linking to `attachmentPath`: `url`
 * is the path, where `fhir-r4` encodes an attachment's `url`, and there is no
 * `data`.
 *
 * @remarks
 * Rewritten on the JSON rather than the decoded resource because `fhir-r4`'s
 * `Attachment.url` decodes to an absolute `URL`, and the link is relative to
 * the snapshot's root.
 */
const withAttachmentUrl = (
  json: DocumentReferenceJson,
  attachmentPath: string
): DocumentReferenceJson => ({
  ...json,
  content: json.content.map((content) => ({
    ...content,
    attachment: { ...Struct.omit(content.attachment, 'data'), url: attachmentPath },
  })),
})

/** A linked source file's JSON without its link, as a {@link Resource} holds it. */
const withoutAttachmentUrl = (json: DocumentReferenceJson): DocumentReferenceJson => ({
  ...json,
  content: json.content.map((content) => ({
    ...content,
    attachment: Struct.omit(content.attachment, 'url'),
  })),
})

/** A resource's file: FHIR R4 JSON at a {@link ResourcePathSchema} path. */
const ResourceTextSchema = Schema.TaggedStruct('Text', {
  path: ResourcePathSchema,
  text: SnapshotFile.JsonTextSchema,
})

/**
 * A {@link Resource} ⇄ its file: the JSON `FhirResourceSchema` encodes the
 * resource to, two-space indented with a trailing newline, a linked source
 * file's attachment carrying its `attachmentPath` as `url`. Decoding checks
 * that the file's path is the resource's own.
 */
const ResourceFileSchema: Schema.Schema<Resource, SnapshotFile.Text> = Schema.transformOrFail(
  ResourceTextSchema,
  Schema.typeSchema(ResourceSchema),
  {
    strict: true,
    decode: (file, _, ast) =>
      Either.gen(function* () {
        const json = yield* ParseResult.decodeUnknownEither(ResourceJsonSchema)(file.text)
        const attachmentPath = attachmentPathLinkedBy(json)
        const resource = yield* ParseResult.decodeUnknownEither(FhirResourceSchema)(
          attachmentPath !== undefined && json.resourceType === 'DocumentReference'
            ? withoutAttachmentUrl(json)
            : json
        )
        const { id } = resource
        if (id === null || file.path !== resourcePathOf(resource.resourceType, id)) {
          return yield* Either.left(
            new ParseResult.Type(
              ast,
              file,
              `${file.path} holds ${resource.resourceType}/${id ?? '<no id>'}.`
            )
          )
        }
        const entry = { _tag: 'Resource', resource: { ...resource, id } } as const
        return attachmentPath === undefined ? entry : { ...entry, attachmentPath }
      }),
    encode: ({ resource, attachmentPath }) =>
      ParseResult.encodeEither(FhirResourceSchema)(resource).pipe(
        Either.map(
          (json) =>
            ({
              _tag: 'Text',
              path: resourcePathOf(resource.resourceType, resource.id),
              text:
                attachmentPath !== undefined && json.resourceType === 'DocumentReference'
                  ? withAttachmentUrl(json, attachmentPath)
                  : json,
            }) as const
        )
      ),
  }
)

/** An attachment's file: its bytes at an {@link AttachmentPathSchema} path. */
const AttachmentBytesSchema = Schema.TaggedStruct('Bytes', {
  path: AttachmentPathPartsSchema,
  bytes: Schema.Uint8ArrayFromSelf,
})

/** An {@link Attachment} ⇄ its file: its bytes, at `<format>/<file name>`. */
const AttachmentFileSchema: Schema.Schema<Attachment, SnapshotFile.Bytes> = Schema.transform(
  AttachmentBytesSchema,
  Schema.typeSchema(AttachmentSchema),
  {
    strict: true,
    decode: ({ path: [format, , fileName], bytes }) =>
      ({ _tag: 'Attachment', format, fileName, bytes }) as const,
    encode: ({ format, fileName, bytes }) =>
      ({ _tag: 'Bytes', path: [format, '/', fileName], bytes }) as const,
  }
)

/** Any entry ⇄ its file. */
const FileSchema: Schema.Schema<Any, SnapshotFile.Any> = Schema.Union(
  ResourceFileSchema,
  AttachmentFileSchema
)

/**
 * The format of the file a source-file `DocumentReference` stores, or
 * `undefined` when it is not one of {@link SOURCE_FILE_IMPORTERS}' source
 * files.
 */
const formatOf = (documentReference: DocumentReference.Type): Format | undefined =>
  SOURCE_FILE_IMPORTERS.find((importer) =>
    PickedFile.isSourceFile(importer.sourceFileFormat)(documentReference)
  )?.format

/**
 * A resource with the attachment it links carried inline again: its one
 * attachment's `data` is `bytes`, base64-encoded, as the importer stored it.
 * A resource that links no attachment is returned as it is.
 *
 * @remarks
 * Checking that `bytes` are the file the attachment describes (its `size` and
 * `hash`) is the reader's, which has the bytes' digest to hand.
 */
const withAttachmentData = (entry: Resource, bytes: Uint8Array): StoredResource => {
  const { resource } = entry
  if (entry.attachmentPath === undefined || resource.resourceType !== 'DocumentReference') {
    return resource
  }
  return {
    ...resource,
    content: resource.content.map((content) => ({
      ...content,
      attachment: { ...content.attachment, data: Encoding.encodeBase64(bytes) },
    })),
  }
}

export {
  AnySchema,
  AttachmentFileSchema,
  attachmentPathOf,
  AttachmentPathSchema,
  AttachmentSchema,
  FileNameSchema,
  FileSchema,
  formatOf,
  FORMATS,
  FormatSchema,
  pathOf,
  ResourceFileSchema,
  ResourceIdSchema,
  resourcePathOf,
  ResourcePathSchema,
  ResourceSchema,
  SOURCE_FILE_IMPORTERS,
  withAttachmentData,
}
export type { Any, Attachment, Format, Resource, StoredResource }
