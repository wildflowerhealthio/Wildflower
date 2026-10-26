/**
 * Where a referent ends up on the device once every `LinkToReferent` choice
 * on the way is followed: the record its mentions are redirected to, named for
 * where that record comes from, or none.
 *
 * @packageDocumentation
 */

import { Data, Option } from 'effect'

import * as LinkableResource from './linkable-resource.ts'
import type * as Referent from './referent.ts'

/** A record already stored on the device. */
interface Stored {
  readonly _tag: 'Stored'
  readonly resource: LinkableResource.WithId
}

/** A record the file brought: the decoded resource of a referent, written as it is. */
interface Decoded {
  readonly _tag: 'Decoded'
  readonly referent: Referent.AsResource
}

/**
 * A record the map makes from the referent's identity alone, standing in
 * until a fuller one arrives (`LinkableResource.maybeProvisionalFor`).
 */
interface Provisional {
  readonly _tag: 'Provisional'
  readonly resource: LinkableResource.WithId
}

/** No record: the referent's mentions stay as they are. */
interface Unlinked {
  readonly _tag: 'Unlinked'
}

type Type = Stored | Decoded | Provisional | Unlinked

const { Stored, Decoded, Provisional, Unlinked, $is: is, $match: match } = Data.taggedEnum<Type>()

/** The relative literal reference a destination's mentions are redirected to; `None` for one with no record to point at. */
const maybeLiteralReference = (destination: Type): Option.Option<string> =>
  match(destination, {
    Stored: ({ resource }) => Option.some(LinkableResource.literalReferenceOf(resource)),
    Provisional: ({ resource }) => Option.some(LinkableResource.literalReferenceOf(resource)),
    Decoded: ({ referent }) =>
      Option.map(Option.fromNullable(referent.resource.id), (id) =>
        LinkableResource.literalReferenceOf({ ...referent.resource, id })
      ),
    Unlinked: () => Option.none(),
  })

export { Decoded, is, match, maybeLiteralReference, Provisional, Stored, Unlinked }
export type {
  Decoded as DecodedType,
  Provisional as ProvisionalType,
  Stored as StoredType,
  Type,
  Unlinked as UnlinkedType,
}
