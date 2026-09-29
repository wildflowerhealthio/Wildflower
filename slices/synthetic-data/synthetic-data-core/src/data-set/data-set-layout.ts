import { dicomImporter } from 'dicom-importer-core'
import { Data, Either, Encoding, Order, type ParseResult, Schema, Struct } from 'effect'
import { type DocumentReference, type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { harImporter } from 'har-importer-core'
import { PickedFile } from 'importer-fundamentals'

/**
 * Where each file of a published data set lives: one file per resource under
 * `fhir/<ResourceType>/<id>.json`, and every file an importer read — a HAR, a
 * DICOM image — under a directory named for its importer's format (`har/`,
 * `dicom/`), linked from the source-file `DocumentReference` the import made
 * for it.
 *
 * @remarks
 * The layout loosely follows FHIR paths but is not a FHIR server: a static
 * host serves it, and `index.json` (`DataSetManifest`) lists what is in it,
 * because a static host cannot list a directory.
 *
 * An import stores the file it read inline, as the `data` of its source-file
 * `DocumentReference`'s attachment. Laid out, that file is written once
 * beside the resources and the attachment carries a `url` to it instead
 * ({@link withStaticFileUrl}); its `contentType`, `size`, `hash` and `title`
 * stay as the importer wrote them. Nothing else changes, so every
 * `meta.source` stamped on the import's resources still names its
 * `DocumentReference` by id.
 */

/** A resource that cannot be given a place in the data set, and why. */
class UnplaceableResource extends Data.TaggedError('UnplaceableResource')<{
  /** `<ResourceType>/<id>`, or `<ResourceType>/<no id>`. */
  readonly resource: string
  readonly reason: string
}> {}

/** Two different contents laid out at one path. */
class ConflictingFiles extends Data.TaggedError('ConflictingFiles')<{
  readonly path: string
}> {}

/** A resource as its file holds it: the FHIR R4 JSON its schema encodes it to. */
type ResourceJson = Schema.Schema.Encoded<typeof FhirResourceSchema>

type DocumentReferenceJson = Extract<ResourceJson, { readonly resourceType: 'DocumentReference' }>

/** One resource laid out: its path, what it is, and the JSON its file holds. */
interface ResourceFile {
  /** `fhir/<ResourceType>/<id>.json`. */
  readonly path: string
  readonly resourceType: FhirResource['resourceType']
  readonly id: string
  readonly json: ResourceJson
}

/** A file an importer read, laid out beside the resources it was read into. */
interface StaticFile {
  /** `<format>/<file name>` (`har/pharmacy.har`, `dicom/chest-x-ray.dcm`). */
  readonly path: string
  readonly bytes: Uint8Array
}

/** A set of resources laid out, each list in path order. */
interface Files {
  readonly resources: readonly ResourceFile[]
  readonly staticFiles: readonly StaticFile[]
}

/** The top-level directory every resource file sits under. */
const FHIR_DIRECTORY = 'fhir'

/**
 * The importers whose source files a data set carries as static files. Each
 * one's `format` names the directory its files sit in, and its
 * `sourceFileFormat` coding is how its source-file `DocumentReference`s are
 * recognized (`PickedFile.isSourceFile`, as the importer's own source-file
 * list recognizes them).
 */
const SOURCE_FILE_IMPORTERS = [harImporter, dicomImporter] as const

/** The directories static files sit in: `har`, `dicom`. */
const STATIC_FILE_DIRECTORIES: readonly string[] = SOURCE_FILE_IMPORTERS.map(
  (importer) => importer.format
)

/** FHIR R4's `id` grammar. */
const FHIR_ID_PATTERN = '[A-Za-z0-9\\-.]{1,64}'

/**
 * The file names a static file may have: a letter or digit, then letters,
 * digits, `.`, `_` or `-` — nothing a path or URL would read as a separator,
 * a parent directory or an escape.
 */
const FILE_NAME_PATTERN = '[A-Za-z0-9][A-Za-z0-9._\\-]{0,127}'

const FHIR_ID = new RegExp(`^${FHIR_ID_PATTERN}$`)

const FILE_NAME = new RegExp(`^${FILE_NAME_PATTERN}$`)

/** A resource id in FHIR R4's id grammar. */
const ResourceIdSchema = Schema.String.pipe(Schema.pattern(FHIR_ID)).annotations({
  identifier: 'DataSetResourceId',
})

/** A resource file's path, as the manifest lists it. */
const ResourcePathSchema = Schema.String.pipe(
  Schema.pattern(new RegExp(`^${FHIR_DIRECTORY}/[A-Z][A-Za-z]*/${FHIR_ID_PATTERN}\\.json$`))
).annotations({
  identifier: 'DataSetResourcePath',
  description: 'A resource file in a data set: fhir/<ResourceType>/<id>.json',
})

/** A static file's path, as the manifest lists it and a source file's `url` links to it. */
const StaticFilePathSchema = Schema.String.pipe(
  Schema.pattern(new RegExp(`^(?:${STATIC_FILE_DIRECTORIES.join('|')})/${FILE_NAME_PATTERN}$`))
).annotations({
  identifier: 'DataSetStaticFilePath',
  description: `A file an importer read, in a data set: <${STATIC_FILE_DIRECTORIES.join('|')}>/<file name>`,
})

/** `fhir/<resourceType>/<id>.json`, for an `id` in FHIR's id grammar. */
const resourcePathOf = (resourceType: FhirResource['resourceType'], id: string): string =>
  `${FHIR_DIRECTORY}/${resourceType}/${id}.json`

/** `<directory>/<fileName>`, for a directory and file name {@link StaticFilePathSchema} accepts. */
const staticFilePathOf = (directory: string, fileName: string): string => `${directory}/${fileName}`

/** `<ResourceType>/<id>`, naming a resource in an error. */
const labelOf = (resource: FhirResource): string =>
  `${resource.resourceType}/${resource.id ?? '<no id>'}`

/**
 * The directory the file a source-file `DocumentReference` stores sits in —
 * its importer's `format` — or `undefined` when it is not one of
 * {@link SOURCE_FILE_IMPORTERS}' source files.
 */
const sourceFileDirectoryOf = (documentReference: DocumentReference.Type): string | undefined =>
  SOURCE_FILE_IMPORTERS.find((importer) =>
    PickedFile.isSourceFile(importer.sourceFileFormat)(documentReference)
  )?.format

/**
 * The file a source-file `DocumentReference` stores inline, at its path in
 * `directory`: its one attachment's `data`, named by its `title` (the name
 * the file was picked under).
 */
const staticFileOf = (
  documentReference: DocumentReference.Type,
  directory: string
): Either.Either<StaticFile, UnplaceableResource> => {
  const unplaceable = (reason: string): Either.Either<never, UnplaceableResource> =>
    Either.left(new UnplaceableResource({ resource: labelOf(documentReference), reason }))
  const [content, ...otherContent] = documentReference.content
  if (content === undefined || otherContent.length > 0) {
    return unplaceable('A source file has exactly one content entry.')
  }
  const { data, title } = content.attachment
  if (data === null) return unplaceable('The source file carries no data.')
  if (title === null || !FILE_NAME.test(title)) {
    return unplaceable(
      `The source file's title ${JSON.stringify(title)} is not a file name a data set can hold (${FILE_NAME_PATTERN}).`
    )
  }
  return Encoding.decodeBase64(data).pipe(
    Either.map((bytes) => ({ path: staticFilePathOf(directory, title), bytes })),
    Either.orElse((error) => unplaceable(`The source file's data is not base64: ${error.message}`))
  )
}

/**
 * A source-file `DocumentReference`'s JSON with its attachment linking to the
 * static file at `staticFilePath` rather than carrying it: `data` is removed
 * and `url` is the path, relative to the data set's root. `contentType`,
 * `size`, `hash` and `title` are kept as the importer wrote them.
 *
 * @remarks
 * Rewritten on the JSON rather than the decoded resource because `fhir-r4`'s
 * `Attachment.url` decodes to an absolute `URL`: a reader resolves the
 * relative path against wherever it fetched the data set from.
 */
const withStaticFileUrl = (
  documentReferenceJson: DocumentReferenceJson,
  staticFilePath: string
): DocumentReferenceJson => ({
  ...documentReferenceJson,
  content: documentReferenceJson.content.map((content) => ({
    ...content,
    attachment: { ...Struct.omit(content.attachment, 'data'), url: staticFilePath },
  })),
})

const encodeResource = Schema.encodeEither(FhirResourceSchema)

/** Whether two byte arrays hold the same bytes. */
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

/** Files by path, by code unit, so the order is the same in every runtime and locale. */
const byPath: Order.Order<{ readonly path: string }> = Order.mapInput(
  Order.string,
  (file: { readonly path: string }) => file.path
)

/**
 * The resources an import writes, one per `<ResourceType>/<id>`: where one
 * repeats, the last copy, as a batch of PUTs applied in order leaves the
 * store.
 *
 * @remarks
 * The Shoppers import holds a prescription's latest fill twice under one id
 * (from the status feed and the history feed), and the copies differ.
 */
const storedResourcesOf = (
  resources: readonly FhirResource[]
): Either.Either<readonly (FhirResource & { readonly id: string })[], UnplaceableResource> =>
  Either.gen(function* () {
    const stored = new Map<string, FhirResource & { readonly id: string }>()
    for (const resource of resources) {
      const { id } = resource
      if (id === null || !FHIR_ID.test(id)) {
        return yield* Either.left(
          new UnplaceableResource({
            resource: labelOf(resource),
            reason: `A resource file needs an id in FHIR's id grammar (${FHIR_ID_PATTERN}).`,
          })
        )
      }
      const path = resourcePathOf(resource.resourceType, id)
      stored.set(path, { ...resource, id })
    }
    return [...stored.values()]
  })

/** A `meta.source` naming a source file, as `MetaSource.makeReference` spells it; the id captured. */
const SOURCE_FILE_REFERENCE = /^DocumentReference\/(.+)$/

/**
 * A resource that names, as its `meta.source`, a `DocumentReference` not
 * among `documentReferencePaths`.
 */
const danglingSourceOf =
  (documentReferencePaths: ReadonlySet<string>) =>
  (resource: FhirResource & { readonly id: string }): UnplaceableResource | undefined => {
    const source = resource.meta?.source ?? null
    const sourceId = source === null ? undefined : SOURCE_FILE_REFERENCE.exec(source)?.[1]
    return sourceId === undefined ||
      documentReferencePaths.has(resourcePathOf('DocumentReference', sourceId))
      ? undefined
      : new UnplaceableResource({
          resource: labelOf(resource),
          reason: `Its meta.source ${source} is not among the resources laid out with it.`,
        })
  }

/** One resource's file, and the static file it stores when it is a source file. */
const filesOf = (
  resource: FhirResource & { readonly id: string }
): Either.Either<Files, UnplaceableResource | ParseResult.ParseError> =>
  Either.gen(function* () {
    const json = yield* encodeResource(resource)
    const { resourceType, id } = resource
    const path = resourcePathOf(resourceType, id)
    if (
      resource.resourceType === 'DocumentReference' &&
      json.resourceType === 'DocumentReference'
    ) {
      const directory = sourceFileDirectoryOf(resource)
      if (directory !== undefined) {
        const staticFile = yield* staticFileOf(resource, directory)
        const linkedJson = withStaticFileUrl(json, staticFile.path)
        return {
          resources: [{ path, resourceType, id, json: linkedJson }],
          staticFiles: [staticFile],
        }
      }
    }
    return { resources: [{ path, resourceType, id, json }], staticFiles: [] }
  })

/**
 * One file per path, in path order; a {@link ConflictingFiles} when two at one
 * path are not `same`.
 */
const distinctByPath = <TFile extends { readonly path: string }>(
  files: readonly TFile[],
  same: (left: TFile, right: TFile) => boolean
): Either.Either<readonly TFile[], ConflictingFiles> =>
  Either.gen(function* () {
    const filesByPath = new Map<string, TFile>()
    for (const file of files) {
      const existing = filesByPath.get(file.path)
      if (existing !== undefined && !same(existing, file)) {
        return yield* Either.left(new ConflictingFiles({ path: file.path }))
      }
      filesByPath.set(file.path, file)
    }
    return [...filesByPath.values()].toSorted(byPath)
  })

const sameStaticFile = (left: StaticFile, right: StaticFile): boolean =>
  sameBytes(left.bytes, right.bytes)

/** Whether two resource files would be written as the same text. */
const sameResourceFile = (left: ResourceFile, right: ResourceFile): boolean =>
  JSON.stringify(left.json) === JSON.stringify(right.json)

/**
 * Several sets of files as one: a file two sets share is written once, and
 * two different files at one path are a {@link ConflictingFiles}.
 */
const merge = (filesList: readonly Files[]): Either.Either<Files, ConflictingFiles> =>
  Either.gen(function* () {
    const resources = yield* distinctByPath(
      filesList.flatMap((files) => files.resources),
      sameResourceFile
    )
    const staticFiles = yield* distinctByPath(
      filesList.flatMap((files) => files.staticFiles),
      sameStaticFile
    )
    return { resources, staticFiles }
  })

/**
 * Lay out the resources one import (or several) made: a file per stored
 * resource, and each source file's data as a static file its
 * `DocumentReference` links to.
 *
 * @param resources - Importer output, in the order the import wrote it; a
 *   repeated `<ResourceType>/<id>` keeps its last copy
 * @returns The resource and static files, each list in path order; an
 *   {@link UnplaceableResource} for a resource with no valid id, a source file
 *   with no data or a title that is not a safe file name, or a resource whose
 *   `meta.source` names a `DocumentReference` not among `resources` (a reader
 *   loading this set would store a dangling source); a
 *   {@link ConflictingFiles} for two different source files at one path
 */
const layOut = (
  resources: readonly FhirResource[]
): Either.Either<Files, UnplaceableResource | ConflictingFiles | ParseResult.ParseError> =>
  Either.gen(function* () {
    const stored = yield* storedResourcesOf(resources)
    const documentReferencePaths = new Set(
      stored
        .filter((resource) => resource.resourceType === 'DocumentReference')
        .map((resource) => resourcePathOf('DocumentReference', resource.id))
    )
    const dangling = stored.map(danglingSourceOf(documentReferencePaths)).find(Boolean)
    if (dangling !== undefined) return yield* Either.left(dangling)
    return yield* merge(yield* Either.all(stored.map(filesOf)))
  })

export {
  byPath,
  ConflictingFiles,
  layOut,
  merge,
  ResourceIdSchema,
  ResourcePathSchema,
  resourcePathOf,
  sourceFileDirectoryOf,
  STATIC_FILE_DIRECTORIES,
  StaticFilePathSchema,
  staticFilePathOf,
  staticFileOf,
  UnplaceableResource,
  withStaticFileUrl,
}
export type { DocumentReferenceJson, Files, ResourceFile, ResourceJson, StaticFile }
