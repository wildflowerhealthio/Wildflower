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
 * A keyed record by its logical key, its `identifier[0]` under its type, so
 * one key covers every file's copy of the record and survives a settings
 * re-decode. A keyless record by its review key, which is unique to its copy.
 *
 * @remarks
 * Structurally equal (`Data`), so it keys a `HashMap` or a `HashSet`.
 */
type Type = Data.TaggedEnum<{
  Keyed: { readonly key: LogicalReference.Key }
  Keyless: { readonly reviewKey: string }
}>

const { Keyed, Keyless, $is: is } = Data.taggedEnum<Type>()

/** Whether `key` is a keyed record's. */
const isKeyed = is('Keyed')

/** The key of the record a logical reference names. */
const fromLogicalReference = (logicalReference: LogicalReference.Type): Type =>
  Keyed({ key: LogicalReference.key(logicalReference) })

/**
 * The logical reference the record `resource` is a copy of is keyed by: its
 * key identifier (`DetachedResource.keyIdentifierOf`) under its type; `None`
 * when it has none, so the record is keyless.
 */
const logicalReferenceIfKeyed = (
  resource: DetachedResource.Type
): Option.Option<LogicalReference.Type> =>
  Option.map(DetachedResource.keyIdentifierOf(resource), (identifier) =>
    LogicalReference.make(resource.resourceType, identifier)
  )

/**
 * The key of the record `resource` is a copy of: `Keyed` by the logical
 * reference it is keyed by ({@link logicalReferenceIfKeyed}), else `Keyless`
 * by `reviewKey`.
 *
 * @param resource - The detached resource a file brought
 * @param reviewKey - The review key of that copy
 */
const make = (resource: DetachedResource.Type, reviewKey: string): Type =>
  Option.match(logicalReferenceIfKeyed(resource), {
    onSome: fromLogicalReference,
    onNone: () => Keyless({ reviewKey }),
  })

export { isKeyed, Keyless, logicalReferenceIfKeyed, make }
export type { Type }
