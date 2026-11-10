/**
 * What the reviewer chooses for a referent, or for one mention: what it links
 * to on the device.
 *
 * @remarks
 * A referent may be `CreateResource` (its own record is written),
 * `UpdateStoredResource` (its own record is written over its stored copy,
 * keeping what the copy assumed) or `LinkToStoredResource` (linked to a
 * resource already on the device); a referent the reviewer has made no
 * choice for takes `CreateResource` (`ReferentLinkChoiceSet.DEFAULT_CHOICE`). A
 * choice for one mention (`MentionLinkChoiceSet`) writes nothing: a
 * {@link MentionLinkChoice} links it to a stored resource, to wherever a
 * referent of the import is linked (`LinkToDecodedReferent`), or to nothing
 * (`DontLink`).
 *
 * @packageDocumentation
 */

import type { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { Data } from 'effect'

import type * as LinkableResource from './linkable-resource.ts'

/** Write the referent's own record. */
interface CreateResource {
  readonly _tag: 'CreateResource'
}

/**
 * Write the referent's own record over `resource`, its stored copy under
 * the same literal reference, keeping every identifier the copy assumed: what
 * a re-import does.
 */
interface UpdateStoredResource {
  readonly _tag: 'UpdateStoredResource'
  readonly resource: LinkableResource.WithId
}

/** Link the referent, or the mention, to a resource already stored on the device. */
interface LinkToStoredResource {
  readonly _tag: 'LinkToStoredResource'
  readonly resource: LinkableResource.WithId
}

/**
 * Link the mention to wherever the referent keyed `referentKey` is linked, so
 * a mention picked onto a record of the import follows that record when its
 * referent is later linked to a stored one.
 */
interface LinkToDecodedReferent {
  readonly _tag: 'LinkToDecodedReferent'
  readonly referentKey: LogicalReference.Key
}

/** Leave the mention linked to nothing: its literal dropped, its `identifier` and `display` kept. */
interface DontLink {
  readonly _tag: 'DontLink'
}

/** A choice for one mention: it writes nothing, and links to a resource that exists, or will, or to none. */
type MentionLinkChoice = LinkToStoredResource | LinkToDecodedReferent | DontLink

/** A choice that writes a resource: the referent's own, as decoded or over its stored copy. */
type WritingLinkChoice = CreateResource | UpdateStoredResource

/** A choice for a referent. */
type Type = WritingLinkChoice | LinkToStoredResource

const {
  CreateResource,
  UpdateStoredResource,
  LinkToStoredResource,
  LinkToDecodedReferent,
  DontLink,
  $is: is,
  $match: match,
} = Data.taggedEnum<Type | MentionLinkChoice>()

/**
 * Why a referent's choice cannot be followed: a stored resource of another
 * type, or a stored resource to update that is not under the referent's own
 * id.
 */
type InvalidLinkChoiceReason = 'StoredResourceOfAnotherType' | 'StoredResourceUnderAnotherId'

/** A choice the stage cannot follow for the referent it is made for. */
class InvalidLinkChoice extends Data.TaggedError('InvalidLinkChoice')<{
  /** The `Referent.key` the choice is made for. */
  readonly referentKey: LogicalReference.Key
  readonly choice: Type
  readonly reason: InvalidLinkChoiceReason
}> {}

export {
  CreateResource,
  DontLink,
  InvalidLinkChoice,
  is,
  LinkToDecodedReferent,
  LinkToStoredResource,
  match,
  UpdateStoredResource,
}
export type {
  CreateResource as CreateResourceType,
  DontLink as DontLinkType,
  InvalidLinkChoiceReason,
  LinkToDecodedReferent as LinkToDecodedReferentType,
  LinkToStoredResource as LinkToStoredResourceType,
  MentionLinkChoice,
  Type,
  UpdateStoredResource as UpdateStoredResourceType,
  WritingLinkChoice,
}
