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
 * `LinkToDecodedReferent` to the end gives a `LinkTarget`.
 *
 * @packageDocumentation
 */

import { Data, HashMap, Option } from 'effect'

import type * as LinkableResource from './linkable-resource.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import * as Referent from './referent.ts'

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

type Type =
  | CreateResource
  | UpdateStoredResource
  | LinkToStoredResource
  | LinkToDecodedReferent
  | DontLink

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

/** The choice a referent takes when the reviewer has made none: `CreateResource` with a resource, else `DontLink`. */
const defaultFor = (referent: Referent.Type): Type =>
  Referent.match(referent, {
    AsResource: () => CreateResource(),
    ByMentionOnly: () => DontLink(),
  })

/** The choice `linkChoices` holds for `referent`, else its default. */
const forReferent = (linkChoices: ReferentLinkChoices.Type, referent: Referent.Type): Type =>
  HashMap.get(linkChoices, Referent.key(referent)).pipe(
    Option.getOrElse(() => defaultFor(referent))
  )

export {
  CreateResource,
  defaultFor,
  DontLink,
  forReferent,
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
  Type,
  UpdateStoredResource as UpdateStoredResourceType,
}
