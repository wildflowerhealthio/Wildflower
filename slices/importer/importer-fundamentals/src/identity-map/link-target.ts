/**
 * A link target: the resource a referent or a mention is linked to, named for
 * where that resource comes from; or, for a mention alone, none.
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

/** No resource: a mention the reviewer chose to leave unlinked (`LinkChoice.DontLink`). */
interface Unlinked {
  readonly _tag: 'Unlinked'
}

/** A target that holds a resource: what every referent is linked to. */
type Linked = Stored | Decoded

type Type = Linked | Unlinked

const { Stored, Decoded, Unlinked, $is: is, $match: match } = Data.taggedEnum<Type>()

/**
 * The resource a link target's mentions are redirected to, whatever its
 * origin; `None` when it is `Unlinked`.
 */
const resourceIfLinked = (linkTarget: Type): Option.Option<LinkableResource.WithId> =>
  match(linkTarget, {
    Stored: ({ resource }) => Option.some(resource),
    Decoded: ({ resource }) => Option.some(resource),
    Unlinked: () => Option.none(),
  })

export { Decoded, is, match, resourceIfLinked, Stored, Unlinked }
export type { Decoded as DecodedType, Linked, Stored as StoredType, Type, Unlinked as UnlinkedType }
