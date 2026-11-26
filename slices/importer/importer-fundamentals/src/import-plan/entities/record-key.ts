/**
 * A record key: what the import plan addresses one record by, whichever file
 * brought it and however often.
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { Data, Option } from 'effect'

/**
 * The two kinds the source supplies, then the importer's own. A record with
 * a key identifier is keyed by identifier (`ByIdentifier`): its logical
 * reference key, its `identifier[0]` under its type, so one key covers every
 * file's copy of the record and survives a settings re-decode. One with no
 * key identifier that a source served at a URL is keyed by source URL
 * (`BySourceUrl`), so every file's copy of it is one record too. Any other
 * is keyed by an importer-assigned key (`ByImporterAssignedKey`), which the
 * importer gives this copy in this batch (the batch reader numbers the
 * picks, and the format's decoder names the record within its file), so it
 * is unique within the batch, means nothing outside it, and no other copy
 * shares it.
 *
 * @remarks
 * Structurally equal (`Data`), so it keys a `HashMap` or a `HashSet`. The
 * source URL is held as its `href`, since two `URL`s are never equal.
 */
type Type = Data.TaggedEnum<{
  ByIdentifier: { readonly logicalReferenceKey: LogicalReference.Key }
  BySourceUrl: { readonly sourceUrl: string }
  ByImporterAssignedKey: { readonly importerAssignedKey: string }
}>

const { ByIdentifier, BySourceUrl, ByImporterAssignedKey, $is: is } = Data.taggedEnum<Type>()

/** Whether `key` keys a record by identifier, one with a key identifier: `ByIdentifier`. */
const isKeyedByIdentifier = is('ByIdentifier')

/** The key of the record keyed by `logicalReference`'s type and identifier. */
const fromLogicalReference = (logicalReference: LogicalReference.Type): Type =>
  ByIdentifier({ logicalReferenceKey: LogicalReference.key(logicalReference) })

/**
 * The key of the record `resource` is a copy of: by identifier, its key
 * identifier (`DetachedResource.keyIdentifierOf`), else by source URL, else
 * by `importerAssignedKey`.
 */
const make = ({
  resource,
  sourceUrl,
  importerAssignedKey,
}: {
  /** The detached resource a file brought. */
  readonly resource: DetachedResource.Type
  /** The URL a source served that copy at (`FileSetRecord.Type`'s `sourceUrl`). */
  readonly sourceUrl: Option.Option<URL>
  /** The key the importer assigned that copy, unique within the batch. */
  readonly importerAssignedKey: string
}): Type =>
  Option.match(DetachedResource.keyIdentifierOf(resource), {
    onSome: (identifier) =>
      fromLogicalReference(LogicalReference.make(resource.resourceType, identifier)),
    onNone: () =>
      Option.match(sourceUrl, {
        onSome: ({ href }) => BySourceUrl({ sourceUrl: href }),
        onNone: () => ByImporterAssignedKey({ importerAssignedKey }),
      }),
  })

export { fromLogicalReference, isKeyedByIdentifier, make }
export type { Type }
