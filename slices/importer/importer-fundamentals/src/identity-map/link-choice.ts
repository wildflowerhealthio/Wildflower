/**
 * What the reviewer chooses for a referent: what it links to on the device.
 *
 * @remarks
 * A referent with a resource may be `CreateResource` (its own resource is
 * written), `UpdateStoredResource` (its own resource is written over its
 * stored copy, keeping what the copy assumed) or `LinkToStoredResource`
 * (linked to a resource already on the device). One named only by mentions
 * may be `LinkToStoredResource`,
 * `LinkToDecodedReferent` (whatever that referent of the same import
 * becomes), or `DontLink` (its mentions keep their identifier-only form); and
 * `CreateResource` when something provisional can stand in for its logical
 * reference (`LinkableResource.tryProvisionalFrom`). Following
 * `LinkToDecodedReferent` to the end gives a `LinkTarget`. A referent the
 * reviewer has made no choice for takes its default
 * (`ReferentLinkChoiceSet.defaultFor`). A choice that writes nothing is a
 * {@link MentionLinkChoice}, one that writes a resource a
 * {@link WritingLinkChoice}; a mention choice is a referent choice with the
 * writing options taken away.
 *
 * @packageDocumentation
 */

import { Data } from 'effect'

import type * as LinkableResource from './linkable-resource.ts'

/** Write the referent's own resource. For a logical reference with a provisional form, create that. */
interface CreateResource {
  readonly _tag: 'CreateResource'
}

/**
 * Write the referent's own resource over `resource`, its stored copy under
 * the same literal reference, keeping every identifier the copy assumed: what
 * a re-import does.
 */
interface UpdateStoredResource {
  readonly _tag: 'UpdateStoredResource'
  readonly resource: LinkableResource.WithId
}

/** Link the referent to a resource already stored on the device. */
interface LinkToStoredResource {
  readonly _tag: 'LinkToStoredResource'
  readonly resource: LinkableResource.WithId
}

/** Link the referent to whatever the decoded referent keyed `referentKey` becomes. */
interface LinkToDecodedReferent {
  readonly _tag: 'LinkToDecodedReferent'
  readonly referentKey: string
}

/** Leave the referent's mentions as they are. */
interface DontLink {
  readonly _tag: 'DontLink'
}

/**
 * A choice that writes nothing: it links to a resource that exists, or will,
 * or to none. What the reviewer may choose for one mention as well as for a
 * referent (`MentionLinkChoiceSet`).
 */
type MentionLinkChoice = LinkToStoredResource | LinkToDecodedReferent | DontLink

/** A choice that writes a resource: the referent's own, as decoded or over its stored copy. */
type WritingLinkChoice = CreateResource | UpdateStoredResource

type Type = MentionLinkChoice | WritingLinkChoice

const {
  CreateResource,
  UpdateStoredResource,
  LinkToStoredResource,
  LinkToDecodedReferent,
  DontLink,
  $is: is,
  $match: match,
} = Data.taggedEnum<Type>()

/**
 * Why a choice cannot be followed for its referent: one its kind does not
 * allow (`DontLink` or `LinkToDecodedReferent` for a referent with a
 * resource, `CreateResource` for one named only by mentions with no
 * provisional form, `UpdateStoredResource` for one named only by mentions), a
 * stored resource or a linked referent of another type, a stored resource to
 * update that is not under the referent's own id, or a linked referent the
 * batch does not hold.
 */
type InvalidLinkChoiceReason =
  | 'NotAllowedForReferent'
  | 'StoredResourceOfAnotherType'
  | 'StoredResourceUnderAnotherId'
  | 'LinkedReferentOfAnotherType'
  | 'LinkedReferentNotInBatch'

/** A choice the stage cannot follow for the referent it is made for. */
class InvalidLinkChoice extends Data.TaggedError('InvalidLinkChoice')<{
  /** The `Referent.key` the choice is made for. */
  readonly referentKey: string
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
