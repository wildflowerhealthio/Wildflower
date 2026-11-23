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
 * The two kinds the source supplies, then the importer's own: a keyed record
 * (one with a key identifier) is keyed `ByIdentifier`, its logical key, its
 * `identifier[0]` under its type, so one key covers every file's copy of the
 * record and survives a settings re-decode. One with no key identifier that a
 * source served at a URL is keyed `BySourceUrl`, so every file's copy of it
 * is one record too. Any other is keyed `ByImporterAssignedKey`: its copy's
 * review key, which the importer assigns to this copy in this batch (the
 * batch reader numbers the picks, and the format's decoder names the record
 * within its file), so it is unique within the batch, means nothing outside
 * it, and no other copy shares it.
 *
 * @remarks
 * Structurally equal (`Data`), so it keys a `HashMap` or a `HashSet`. The
 * source URL is held as its `href`, since two `URL`s are never equal.
 */
type Type = Data.TaggedEnum<{
  ByIdentifier: { readonly key: LogicalReference.Key }
  BySourceUrl: { readonly sourceUrl: string }
  ByImporterAssignedKey: { readonly reviewKey: string }
}>

const { ByIdentifier, BySourceUrl, ByImporterAssignedKey, $is: is } = Data.taggedEnum<Type>()

/** Whether `key` is a keyed record's, one with a key identifier: `ByIdentifier`. */
const isKeyed = is('ByIdentifier')

/** The key of the record keyed by `logicalReference`'s type and identifier. */
const fromLogicalReference = (logicalReference: LogicalReference.Type): Type =>
  ByIdentifier({ key: LogicalReference.key(logicalReference) })

/**
 * The key of the record `resource` is a copy of: `ByIdentifier`, its key
 * identifier (`DetachedResource.keyIdentifierOf`), else `BySourceUrl`, else
 * `ByImporterAssignedKey`, `reviewKey`.
 */
const make = ({
  resource,
  sourceUrl,
  reviewKey,
}: {
  /** The detached resource a file brought. */
  readonly resource: DetachedResource.Type
  /** The URL a source served that copy at (`FileSetRecord.Type`'s `sourceUrl`). */
  readonly sourceUrl: Option.Option<URL>
  /** The review key of that copy. */
  readonly reviewKey: string
}): Type =>
  Option.match(DetachedResource.keyIdentifierOf(resource), {
    onSome: (identifier) =>
      fromLogicalReference(LogicalReference.make(resource.resourceType, identifier)),
    onNone: () =>
      Option.match(sourceUrl, {
        onSome: ({ href }) => BySourceUrl({ sourceUrl: href }),
        onNone: () => ByImporterAssignedKey({ reviewKey }),
      }),
  })

export { ByImporterAssignedKey, BySourceUrl, fromLogicalReference, isKeyed, make }
export type { Type }
