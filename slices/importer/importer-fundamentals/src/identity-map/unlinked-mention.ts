/**
 * The mentions a placed file still has that the map could link and did not,
 * and the resources it leaves in no patient's compartment: what a review
 * lists as needing a patient or a provider.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Data, Option } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as Mention from './mention.ts'

/**
 * A resource that, as written, is in no patient's compartment: it has a
 * `subject` slot and nothing in it lands on a patient of the device, the
 * slot empty, a `display` alone, an absolute URL into another system, a
 * contained `#<id>`, or an untyped identifier.
 *
 * @remarks
 * FHIR's CompartmentDefinition for Patient says which fields place each
 * resource type in a patient's compartment; for every type the importer
 * handles that is `subject`. The viewing apps read by patient, so a resource
 * outside every compartment is one nothing finds. A `subject` that is a
 * logical reference the map left unlinked is a {@link Dangling} mention
 * instead, since the map can still link it.
 */
interface OutsidePatientCompartment {
  readonly _tag: 'OutsidePatientCompartment'
  /** The `DecodedFile.Resource` key of the resource. */
  readonly mentioningResourceKey: string
}

/**
 * A mention the map could link and did not: a logical reference, in any
 * field, still identifier-only after placement because its referent is
 * `Unlinked`.
 */
interface Dangling {
  readonly _tag: 'Dangling'
  /** The `DecodedFile.Resource` key of the resource carrying the mention. */
  readonly mentioningResourceKey: string
  /** The mention's path in it: see `Mention.Type.path`. */
  readonly mentionPath: string
  /** The reference as it will be written. */
  readonly referenceAsWritten: IdentifierAndReference.ReferenceType
}

type Type = OutsidePatientCompartment | Dangling

const { OutsidePatientCompartment, Dangling, $is: is, $match: match } = Data.taggedEnum<Type>()

/** Whether a placed reference is a logical reference the map left unlinked. */
const isDangling = (referenceAsWritten: IdentifierAndReference.ReferenceType): boolean =>
  Option.isSome(LinkableLogicalReference.tryFromReference(referenceAsWritten))

/**
 * Every resource of `placedFile` outside every patient's compartment, and
 * every dangling mention of it, in review order.
 *
 * @param placedFile - A decoded file after placement (`IdentityMap.apply`)
 */
const collect = (placedFile: DecodedFile.DecodedFile): readonly Type[] =>
  DecodedFile.resources(placedFile).flatMap(({ key, resource }): readonly Type[] => {
    const outsideCompartment: readonly Type[] =
      'subject' in resource &&
      (resource.subject === null ||
        (!Mention.landsOnDevice(resource.subject) && !isDangling(resource.subject)))
        ? [OutsidePatientCompartment({ mentioningResourceKey: key })]
        : []
    const dangling = Mention.of(resource)
      .filter(({ reference }) => isDangling(reference))
      .map(({ path, reference }): Type =>
        Dangling({ mentioningResourceKey: key, mentionPath: path, referenceAsWritten: reference })
      )
    return [...outsideCompartment, ...dangling]
  })

export { collect, is, match }
export type { Dangling, OutsidePatientCompartment, Type }
