/**
 * What the reviewer chooses for a referent: what it links to on the device.
 *
 * @remarks
 * A referent with a resource may be `CreateResource` (its own resource is
 * written) or `LinkToStoredResource` (linked to a resource already on the
 * device). One named only by mentions may be `LinkToStoredResource`,
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

type Type = CreateResource | LinkToStoredResource | LinkToDecodedReferent | DontLink

const {
  CreateResource,
  LinkToStoredResource,
  LinkToDecodedReferent,
  DontLink,
  $is: is,
  $match: match,
} = Data.taggedEnum<Type>()

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
  is,
  LinkToDecodedReferent,
  LinkToStoredResource,
  match,
}
export type {
  CreateResource as CreateResourceType,
  DontLink as DontLinkType,
  LinkToDecodedReferent as LinkToDecodedReferentType,
  LinkToStoredResource as LinkToStoredResourceType,
  Type,
}
