/**
 * Where a referent ends up on the device once every `SameAs` choice on the way
 * is followed: the resource its mentions are redirected to, or none.
 *
 * @packageDocumentation
 */

import { Data, Option } from 'effect'

import * as LinkableResource from './linkable-resource.ts'
import type * as Referent from './referent.ts'

/** A resource already on the device. */
interface OnStoredResource {
  readonly _tag: 'OnStoredResource'
  readonly resource: LinkableResource.WithId
}

/** The referent's own decoded resource, written as the record. */
interface OnOwnResource {
  readonly _tag: 'OnOwnResource'
  readonly referent: Referent.AsResource
}

/**
 * A resource created for the referent's identity alone, standing in until a
 * fuller record arrives (`Provisional.forIdentity`).
 */
interface OnProvisionalResource {
  readonly _tag: 'OnProvisionalResource'
  readonly resource: LinkableResource.WithId
}

/** No resource: the referent's mentions stay as they are. */
interface Unlinked {
  readonly _tag: 'Unlinked'
}

type Type = OnStoredResource | OnOwnResource | OnProvisionalResource | Unlinked

const {
  OnStoredResource,
  OnOwnResource,
  OnProvisionalResource,
  Unlinked,
  $is: is,
  $match: match,
} = Data.taggedEnum<Type>()

/** The relative literal a destination's mentions are redirected to, or `None` for one with no resource to point at. */
const literalOf = (destination: Type): Option.Option<string> =>
  match(destination, {
    OnStoredResource: ({ resource }) => Option.some(LinkableResource.literalOf(resource)),
    OnProvisionalResource: ({ resource }) => Option.some(LinkableResource.literalOf(resource)),
    OnOwnResource: ({ referent }) =>
      Option.map(Option.fromNullable(referent.resource.id), (id) =>
        LinkableResource.literalOf({ ...referent.resource, id })
      ),
    Unlinked: () => Option.none(),
  })

export { is, literalOf, match, OnOwnResource, OnProvisionalResource, OnStoredResource, Unlinked }
export type {
  OnOwnResource as OnOwnResourceType,
  OnProvisionalResource as OnProvisionalResourceType,
  OnStoredResource as OnStoredResourceType,
  Type,
  Unlinked as UnlinkedType,
}
