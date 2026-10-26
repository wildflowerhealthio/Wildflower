/**
 * The mentions a placed file still has that land on no record of the device,
 * and the resources it leaves in no patient's compartment: what a review
 * lists as needing a patient or a provider.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Data, Option } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as LogicalReference from './logical-reference.ts'
import * as Mention from './mention.ts'

/**
 * A resource that, as written, is in no patient's compartment: it has a
 * `subject` slot and names no patient in it at all, the slot empty or a
 * `display` alone.
 *
 * @remarks
 * FHIR's CompartmentDefinition for Patient says which fields place each
 * resource type in a patient's compartment; for every type the importer
 * handles that is `subject`. The viewing apps read by patient, so a resource
 * outside every compartment is one nothing finds. A `subject` that names
 * someone and lands nowhere is a {@link Dangling} mention instead.
 */
interface OutsidePatientCompartment {
  readonly _tag: 'OutsidePatientCompartment'
  /** The `DecodedFile.Resource` key of the resource. */
  readonly mentioningResourceKey: string
}

/**
 * A mention that names something, a logical reference or an absolute URL, and
 * still lands on no record of the device after placement: its referent
 * `Unlinked`, or its target in another system.
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

/** Whether a mention's reference lands on a record of the device: a literal reference that is not an absolute URL. */
const landsOnDevice = (reference: IdentifierAndReference.ReferenceType): boolean =>
  reference.reference !== null && URL.parse(reference.reference) === null

/** Whether a reference names something, an absolute URL or a logical reference, as opposed to a `display` alone or an untyped identifier. */
const namesSomething = (reference: IdentifierAndReference.ReferenceType): boolean =>
  reference.reference !== null || Option.isSome(LogicalReference.maybeOfReference(reference))

/**
 * Every resource of `placedFile` outside every patient's compartment, and
 * every mention of it that names something and lands on no record of the
 * device, in review order.
 *
 * @param placedFile - A decoded file after placement (`IdentityMap.apply`)
 */
const collect = (placedFile: DecodedFile.DecodedFile): readonly Type[] =>
  DecodedFile.resources(placedFile).flatMap(({ key, resource }): readonly Type[] => {
    const outsideCompartment: readonly Type[] =
      'subject' in resource && (resource.subject === null || !namesSomething(resource.subject))
        ? [OutsidePatientCompartment({ mentioningResourceKey: key })]
        : []
    const dangling = Mention.of(resource)
      .filter((mention) => !landsOnDevice(mention.reference) && namesSomething(mention.reference))
      .map((mention): Type =>
        Dangling({
          mentioningResourceKey: key,
          mentionPath: mention.path,
          referenceAsWritten: mention.reference,
        })
      )
    return [...outsideCompartment, ...dangling]
  })

export { collect, is, match }
export type { Dangling, OutsidePatientCompartment, Type }
