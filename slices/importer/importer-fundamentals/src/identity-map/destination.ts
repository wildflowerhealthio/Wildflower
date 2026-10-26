/**
 * Where a referent ends up on the device once every `LinkToReferent` choice
 * on the way is followed: the record its mentions are redirected to, named for
 * where that record comes from, or none.
 *
 * @packageDocumentation
 */

import { Data, Option } from 'effect'

import type * as LinkableResource from './linkable-resource.ts'

/** A record already stored on the device. */
interface Stored {
  readonly _tag: 'Stored'
  readonly resource: LinkableResource.WithId
}

/** A record the file brought: a referent's decoded resource, written where it was decoded. */
interface Decoded {
  readonly _tag: 'Decoded'
  readonly resource: LinkableResource.WithId
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

/** The record a destination's mentions are redirected to, whatever its origin; `None` for `Unlinked`. */
const maybeRecordOf = (destination: Type): Option.Option<LinkableResource.WithId> =>
  match(destination, {
    Stored: ({ resource }) => Option.some(resource),
    Decoded: ({ resource }) => Option.some(resource),
    Provisional: ({ resource }) => Option.some(resource),
    Unlinked: () => Option.none(),
  })

export { Decoded, is, match, maybeRecordOf, Provisional, Stored, Unlinked }
export type {
  Decoded as DecodedType,
  Provisional as ProvisionalType,
  Stored as StoredType,
  Type,
  Unlinked as UnlinkedType,
}
