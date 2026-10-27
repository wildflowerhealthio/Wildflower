/**
 * A link target: the resource a referent is linked to once every
 * `LinkToDecodedReferent` choice on the way is followed, named for where that
 * resource comes from; or none.
 *
 * @packageDocumentation
 */

import { Data, Option } from 'effect'

import type * as LinkableResource from './linkable-resource.ts'

/** A resource already stored on the device. */
interface Stored {
  readonly _tag: 'Stored'
  readonly resource: LinkableResource.WithId
}

/**
 * A resource the file brought: a referent's decoded resource, written where it
 * was decoded; over its `storedCopy`, the stored resource under the same
 * literal reference, when the choice named one (a re-import's
 * `LinkChoice.UpdateStoredResource`).
 */
interface Decoded {
  readonly _tag: 'Decoded'
  readonly resource: LinkableResource.WithId
  readonly storedCopy: Option.Option<LinkableResource.WithId>
}

/**
 * A resource the map makes from the referent's logical reference alone,
 * standing in until a fuller one arrives (`LinkableResource.tryProvisionalFrom`).
 */
interface Provisional {
  readonly _tag: 'Provisional'
  readonly resource: LinkableResource.WithId
}

/** No resource: the referent's mentions stay as they are. */
interface Unlinked {
  readonly _tag: 'Unlinked'
}

type Type = Stored | Decoded | Provisional | Unlinked

const { Stored, Decoded, Provisional, Unlinked, $is: is, $match: match } = Data.taggedEnum<Type>()

/** The resource a link target's mentions are redirected to, whatever its origin; `None` for `Unlinked`. */
const tryIntoResource = (linkTarget: Type): Option.Option<LinkableResource.WithId> =>
  match(linkTarget, {
    Stored: ({ resource }) => Option.some(resource),
    Decoded: ({ resource }) => Option.some(resource),
    Provisional: ({ resource }) => Option.some(resource),
    Unlinked: () => Option.none(),
  })

export { Decoded, is, match, Provisional, Stored, tryIntoResource, Unlinked }
export type {
  Decoded as DecodedType,
  Provisional as ProvisionalType,
  Stored as StoredType,
  Type,
  Unlinked as UnlinkedType,
}
