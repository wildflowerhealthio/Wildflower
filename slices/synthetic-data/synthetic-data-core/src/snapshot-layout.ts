import { Data, Either, Encoding, type ParseResult, Schema } from 'effect'
import type { DocumentReference, FhirResource } from 'fhir-r4/resources'
import { MetaSource } from 'importer-fundamentals'

import * as Entry from './snapshot-entry.ts'
import * as SnapshotFile from './snapshot-file.ts'

/**
 * Importer output laid out as a snapshot's entries: one {@link Entry.Resource}
 * per `<ResourceType>/<id>`, and one {@link Entry.Attachment} per file an
 * importer read, which its source-file `DocumentReference` links instead of
 * carrying inline.
 */

/** A resource that cannot be given a place in a snapshot, and why. */
class UnplaceableResource extends Data.TaggedError('UnplaceableResource')<{
  /** `<ResourceType>/<id>`, or `<ResourceType>/<no id>`. */
  readonly resource: string
  readonly reason: string
}> {}

/** Two different entries laid out at one path. */
class ConflictingFiles extends Data.TaggedError('ConflictingFiles')<{
  readonly path: string
}> {}

/** `<ResourceType>/<id>`, naming a resource in an error. */
const labelOf = (resource: FhirResource): string =>
  `${resource.resourceType}/${resource.id ?? '<no id>'}`

const isResourceId = Schema.is(Entry.ResourceIdSchema)

const isFileName = Schema.is(Entry.FileNameSchema)

/**
 * The file a source-file `DocumentReference` stores inline, as an attachment
 * of `format`: its one attachment's `data`, named by its `title` (the name the
 * file was picked under).
 */
const attachmentOf = (
  documentReference: DocumentReference.Type,
  format: Entry.Format
): Either.Either<Entry.Attachment, UnplaceableResource> => {
  const unplaceable = (reason: string): Either.Either<never, UnplaceableResource> =>
    Either.left(new UnplaceableResource({ resource: labelOf(documentReference), reason }))
  const [content, ...otherContent] = documentReference.content
  if (content === undefined || otherContent.length > 0) {
    return unplaceable('A source file has exactly one content entry.')
  }
  const { data, title } = content.attachment
  if (data === null) return unplaceable('The source file carries no data.')
  if (title === null || !isFileName(title)) {
    return unplaceable(
      `The source file's title ${JSON.stringify(title)} is not a file name a snapshot can hold.`
    )
  }
  return Encoding.decodeBase64(data).pipe(
    Either.map((bytes) => ({ _tag: 'Attachment', format, fileName: title, bytes }) as const),
    Either.orElse((error) => unplaceable(`The source file's data is not base64: ${error.message}`))
  )
}

/**
 * The resources an import writes, one per `<ResourceType>/<id>`: where one
 * repeats, the last copy, as a batch of PUTs applied in order leaves the
 * store.
 */
const storedResourcesOf = (
  resources: readonly FhirResource[]
): Either.Either<readonly Entry.StoredResource[], UnplaceableResource> =>
  Either.gen(function* () {
    const stored = new Map<string, Entry.StoredResource>()
    for (const resource of resources) {
      const { id } = resource
      if (id === null || !isResourceId(id)) {
        return yield* Either.left(
          new UnplaceableResource({
            resource: labelOf(resource),
            reason: "A resource in a snapshot needs an id in FHIR's id grammar.",
          })
        )
      }
      stored.set(Entry.resourcePathOf(resource.resourceType, id), { ...resource, id })
    }
    return [...stored.values()]
  })

/** What every `meta.source` naming a source file starts with (`MetaSource.makeReference`). */
const SOURCE_FILE_REFERENCE_PREFIX = MetaSource.makeReference('')

/**
 * A resource that names, as its `meta.source`, a source-file
 * `DocumentReference` other than the `laidOutSources`.
 */
const danglingSourceOf =
  (laidOutSources: ReadonlySet<string>) =>
  (resource: Entry.StoredResource): UnplaceableResource | undefined => {
    const source = resource.meta?.source ?? null
    return source === null ||
      !source.startsWith(SOURCE_FILE_REFERENCE_PREFIX) ||
      laidOutSources.has(source)
      ? undefined
      : new UnplaceableResource({
          resource: labelOf(resource),
          reason: `Its meta.source ${source} is not among the resources laid out with it.`,
        })
  }

/**
 * One resource's entry, and the attachment it stores when it is a source
 * file: then its own attachment carries neither `data` nor `url`, and links
 * the attachment by path.
 */
const entriesOf = (
  resource: Entry.StoredResource
): Either.Either<readonly Entry.Any[], UnplaceableResource> => {
  const format =
    resource.resourceType === 'DocumentReference' ? Entry.formatOf(resource) : undefined
  if (resource.resourceType !== 'DocumentReference' || format === undefined) {
    return Either.right([{ _tag: 'Resource', resource }])
  }
  return attachmentOf(resource, format).pipe(
    Either.map((attachment) => [
      {
        _tag: 'Resource',
        resource: {
          ...resource,
          content: resource.content.map((content) => ({
            ...content,
            attachment: { ...content.attachment, data: null, url: null },
          })),
        },
        attachmentPath: Entry.pathOf(attachment),
      },
      attachment,
    ])
  )
}

const encodeEntry = Schema.encodeEither(Entry.FileSchema)

/** Whether two entries at one path are written as the same file. */
const sameEntry = (
  left: Entry.Any,
  right: Entry.Any
): Either.Either<boolean, ParseResult.ParseError> =>
  Either.gen(function* () {
    if (left === right) return true
    return SnapshotFile.same(yield* encodeEntry(left), yield* encodeEntry(right))
  })

/**
 * Several lists of entries as one, in path order: an entry two lists share is
 * kept once, and two entries at one path that are not written as the same
 * file are a {@link ConflictingFiles}.
 */
const merge = (
  entryLists: readonly (readonly Entry.Any[])[]
): Either.Either<readonly Entry.Any[], ConflictingFiles | ParseResult.ParseError> =>
  Either.gen(function* () {
    const entriesByPath = new Map<string, Entry.Any>()
    for (const entry of entryLists.flat()) {
      const path = Entry.pathOf(entry)
      const existing = entriesByPath.get(path)
      if (existing !== undefined && !(yield* sameEntry(existing, entry))) {
        return yield* Either.left(new ConflictingFiles({ path }))
      }
      entriesByPath.set(path, entry)
    }
    return [...entriesByPath.entries()]
      .toSorted(([left], [right]) => SnapshotFile.byPath({ path: left }, { path: right }))
      .map(([, entry]) => entry)
  })

/**
 * Lay out the resources one import (or several) made: an entry per stored
 * resource, and each source file's data as an attachment its
 * `DocumentReference` links to.
 *
 * @param resources - Importer output, in the order the import wrote it; a
 *   repeated `<ResourceType>/<id>` keeps its last copy
 * @returns The entries, in path order; an {@link UnplaceableResource} for a
 *   resource with no valid id, a source file with no data or a title that is
 *   not a safe file name, or a resource whose `meta.source` names a
 *   `DocumentReference` not among `resources` (a reader loading this snapshot
 *   would store a dangling source); a {@link ConflictingFiles} for two
 *   different source files at one path
 */
const layOut = (
  resources: readonly FhirResource[]
): Either.Either<
  readonly Entry.Any[],
  UnplaceableResource | ConflictingFiles | ParseResult.ParseError
> =>
  Either.gen(function* () {
    const stored = yield* storedResourcesOf(resources)
    const laidOutSources = new Set(
      stored
        .filter((resource) => resource.resourceType === 'DocumentReference')
        .map((resource) => MetaSource.makeReference(resource.id))
    )
    const dangling = stored.map(danglingSourceOf(laidOutSources)).find(Boolean)
    if (dangling !== undefined) return yield* Either.left(dangling)
    return yield* merge(yield* Either.all(stored.map(entriesOf)))
  })

export { ConflictingFiles, layOut, merge, UnplaceableResource }
