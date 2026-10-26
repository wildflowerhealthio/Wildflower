/**
 * What the reviewer chooses for a referent: what it links to on the device.
 *
 * @remarks
 * A referent with a resource may be `Create` (its own resource is written and
 * becomes the record) or `LinkToStored` (linked to a record already on the
 * device). One named only by mentions may be `LinkToStored`, `LinkToReferent`
 * (whatever that referent becomes), or `DontLink` (its mentions keep their
 * identifier-only form); and `Create` when something provisional can stand in
 * for its identity (`LinkableResource.maybeProvisionalFor`). Following
 * `LinkToReferent` to the end gives a `Destination`.
 *
 * @packageDocumentation
 */

import { Data } from 'effect'

import type * as IdentityMap from './identity-map.ts'
import type * as LinkableResource from './linkable-resource.ts'
import * as Referent from './referent.ts'

/** Write the referent's own resource as the record. For an identity with a provisional form, create that. */
interface Create {
  readonly _tag: 'Create'
}

/** Link the referent to a record already stored on the device. */
interface LinkToStored {
  readonly _tag: 'LinkToStored'
  readonly resource: LinkableResource.WithId
}

/** Link the referent to whatever the referent keyed `referentKey` becomes. */
interface LinkToReferent {
  readonly _tag: 'LinkToReferent'
  readonly referentKey: string
}

/** Leave the referent's mentions as they are. */
interface DontLink {
  readonly _tag: 'DontLink'
}

type Type = Create | LinkToStored | LinkToReferent | DontLink

const {
  Create,
  LinkToStored,
  LinkToReferent,
  DontLink,
  $is: is,
  $match: match,
} = Data.taggedEnum<Type>()

/** The choice a referent takes when the reviewer has made none: `Create` with a resource, else `DontLink`. */
const defaultFor = (referent: Referent.Type): Type =>
  Referent.match(referent, { AsResource: () => Create(), ByMentionOnly: () => DontLink() })

/** The choice `identityMap` holds for `referent`, else its default. */
const forReferent = (identityMap: IdentityMap.Type, referent: Referent.Type): Type =>
  identityMap.get(Referent.key(referent)) ?? defaultFor(referent)

export { Create, defaultFor, DontLink, forReferent, is, LinkToReferent, LinkToStored, match }
export type {
  Create as CreateType,
  DontLink as DontLinkType,
  LinkToReferent as LinkToReferentType,
  LinkToStored as LinkToStoredType,
  Type,
}
