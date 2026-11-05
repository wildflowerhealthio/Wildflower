/**
 * A resource plan: where one decoded record is written, decided before any
 * record of its set is adopted.
 *
 * @remarks
 * As a FHIR server processes a transaction bundle: it first decides the id
 * every entry is stored under, then rewrites each reference between entries
 * to the id its target got. A keyed record's id is the one its key derives,
 * so a re-import lands on the same id; a keyless one's is minted.
 *
 * @packageDocumentation
 */
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import { Data, Option } from 'effect'

/**
 * A keyed record's plan: the id its key derives,
 * `localResourceId(key.system, Type, key.value)`, the same on every import.
 */
interface Derived {
  readonly _tag: 'Derived'
  readonly resourceType: DetachedResource.Type['resourceType']
  readonly id: string
  /** The record's key, its `identifier[0]`. */
  readonly identifier: IdentifierAndReference.QualifiedIdentifierType
}

/** A keyless record's plan: an id minted for it, a new one on every import. */
interface Minted {
  readonly _tag: 'Minted'
  readonly resourceType: DetachedResource.Type['resourceType']
  readonly id: string
}

/** Where one record is written: its type and id, derived from its key or minted. */
type Type = Derived | Minted

const { Derived, Minted, $match: match } = Data.taggedEnum<Type>()

/**
 * The plan of `resource`: `Derived` from its key when it is keyed, the id
 * derived here, once; `Minted` by `mintId` when it is keyless.
 *
 * @param mintId - Mints the id of a keyless record; random outside tests
 */
const of = (resource: DetachedResource.Type, mintId: () => string): Type =>
  Option.match(DetachedResource.keyIdentifierOf(resource), {
    onSome: (identifier) =>
      Derived({
        resourceType: resource.resourceType,
        id: localResourceId(identifier.system.href, resource.resourceType, identifier.value),
        identifier,
      }),
    onNone: () => Minted({ resourceType: resource.resourceType, id: mintId() }),
  })

/** The literal reference the planned record is written under, `<Type>/<id>`. */
const literalReference = ({ resourceType, id }: Type): string => `${resourceType}/${id}`

export { Derived, literalReference, match, Minted, of }
export type { Type }
