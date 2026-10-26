/**
 * What the reviewer chooses for a referent: what it links to on the device.
 *
 * @remarks
 * A referent with a resource may be `New` (its own resource is written and
 * becomes the record) or `ToStored` (linked to a resource already on the
 * device). One named only by mentions may be `ToStored`, `SameAs` another referent
 * (whatever that one becomes), or `DontLink` (its mentions keep their
 * identifier-only form); and `New` when something provisional can stand in for
 * its identity (`Provisional.forIdentity`). Following `SameAs` to the end gives
 * a `Destination`.
 *
 * @packageDocumentation
 */

import { Data } from 'effect'

import type * as LinkableResource from './linkable-resource.ts'
import * as Referent from './referent.ts'

/** Write the referent's own resource; it becomes the record. For a provisional case, create one. */
interface New {
  readonly _tag: 'New'
}

/** Link the referent to a resource already on the device. */
interface ToStored {
  readonly _tag: 'ToStored'
  readonly resource: LinkableResource.WithId
}

/** Link the referent to whatever the referent keyed `referentKey` becomes. */
interface SameAs {
  readonly _tag: 'SameAs'
  readonly referentKey: string
}

/** Leave the referent's mentions as they are. */
interface DontLink {
  readonly _tag: 'DontLink'
}

type Type = New | ToStored | SameAs | DontLink

const { New, ToStored, SameAs, DontLink, $is: is, $match: match } = Data.taggedEnum<Type>()

/** Every referent's choice, keyed by `Referent.key`. A referent missing from it takes its default. */
type ByReferent = ReadonlyMap<string, Type>

/** The choice a referent takes when the reviewer has made none: `New` with a resource, else `DontLink`. */
const defaultFor = (referent: Referent.Type): Type =>
  Referent.match(referent, { AsResource: () => New(), ByMentionOnly: () => DontLink() })

/** The choice `choices` holds for `referent`, else its default. */
const forReferent = (choices: ByReferent, referent: Referent.Type): Type =>
  choices.get(Referent.key(referent)) ?? defaultFor(referent)

export { defaultFor, DontLink, forReferent, is, match, New, SameAs, ToStored }
export type {
  ByReferent,
  DontLink as DontLinkType,
  New as NewType,
  SameAs as SameAsType,
  ToStored as ToStoredType,
  Type,
}
