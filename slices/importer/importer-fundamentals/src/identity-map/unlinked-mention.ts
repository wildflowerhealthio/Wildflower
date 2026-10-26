/**
 * The mentions a placed file still has that name nobody on the device: what a
 * review lists as needing a patient or a provider.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as Mention from './mention.ts'

/** A resource of a type that carries a `subject`, with none. */
interface MissingSubject {
  readonly _tag: 'MissingSubject'
  /** The `DecodedFile.Resource` key of the resource. */
  readonly mentioningResourceKey: string
}

/**
 * A mention that, as written, lands on no resource of the device: still
 * identifier-only after placement (an unlinked or unmapped identity), or an
 * absolute URL into another system.
 */
interface NamesNobodyOnDevice {
  readonly _tag: 'NamesNobodyOnDevice'
  /** The `DecodedFile.Resource` key of the resource carrying the mention. */
  readonly mentioningResourceKey: string
  /** The mention's path in it: see `Mention.Type.path`. */
  readonly mentionPath: string
  /** The reference as it will be written. */
  readonly referenceAsWritten: IdentifierAndReference.ReferenceType
}

type Type = MissingSubject | NamesNobodyOnDevice

/** Whether a mention's reference lands on a resource of the device: a literal that is not an absolute URL. */
const landsOnDevice = (reference: IdentifierAndReference.ReferenceType): boolean =>
  reference.reference !== null && URL.parse(reference.reference) === null

/**
 * Whether a mention that lands nowhere is one to list: every `subject`, and a
 * `requester` or `performer` that names something, an absolute URL or an
 * identity, as opposed to a `display` alone, which names nobody the map could
 * ever link.
 */
const namesSomeone = (mentioningResource: FhirResource, mention: Mention.Type): boolean =>
  mention.field === 'subject' ||
  mention.reference.reference !== null ||
  Option.isSome(Mention.identityOf(mentioningResource, mention.reference))

/**
 * Every mention of `placedFile` that names nobody on the device, and every
 * missing `subject`, in review order.
 *
 * @param placedFile - A decoded file after placement (`IdentityMap.apply`)
 *
 * @remarks
 * A `subject` lands only through a relative literal, so every subject-bearing
 * resource without one is listed. A `requester` or `performer` that is a
 * `display` alone (a lab the report prints) is not.
 */
const of = (placedFile: DecodedFile.DecodedFile): readonly Type[] =>
  DecodedFile.resources(placedFile).flatMap(({ key, resource }): readonly Type[] => {
    const missingSubject: readonly Type[] =
      'subject' in resource && resource.subject === null
        ? [{ _tag: 'MissingSubject', mentioningResourceKey: key }]
        : []
    const landingNowhere = Mention.of(resource)
      .filter((mention) => !landsOnDevice(mention.reference) && namesSomeone(resource, mention))
      .map((mention): Type => ({
        _tag: 'NamesNobodyOnDevice',
        mentioningResourceKey: key,
        mentionPath: mention.path,
        referenceAsWritten: mention.reference,
      }))
    return [...missingSubject, ...landingNowhere]
  })

export { of }
export type { MissingSubject, NamesNobodyOnDevice, Type }
