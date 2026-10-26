/**
 * The mentions a placed file still has that land on no record of the device:
 * what a review lists as needing a patient or a provider.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Data, Option } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as Mention from './mention.ts'

/** A resource of a type that carries a `subject`, with none. */
interface MissingSubject {
  readonly _tag: 'MissingSubject'
  /** The `DecodedFile.Resource` key of the resource. */
  readonly mentioningResourceKey: string
}

/**
 * A mention that, as written, lands on no record of the device: still
 * identifier-only after placement (its referent `Unlinked`), or an absolute
 * URL into another system.
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

type Type = MissingSubject | Dangling

const { MissingSubject, Dangling, $is: is, $match: match } = Data.taggedEnum<Type>()

/** Whether a mention's reference lands on a record of the device: a literal reference that is not an absolute URL. */
const landsOnDevice = (reference: IdentifierAndReference.ReferenceType): boolean =>
  reference.reference !== null && URL.parse(reference.reference) === null

/**
 * Whether a mention that lands nowhere is one to list: every `subject`, and a
 * `requester` or `performer` that names something, an absolute URL or an
 * identity, as opposed to a `display` alone, which names nothing the map
 * could ever link.
 */
const namesSomething = (mentioningResource: FhirResource, mention: Mention.Type): boolean =>
  mention.field === 'subject' ||
  mention.reference.reference !== null ||
  Option.isSome(Mention.maybeIdentityOf(mentioningResource, mention.reference))

/**
 * Every mention of `placedFile` that lands on no record of the device, and
 * every missing `subject`, in review order.
 *
 * @param placedFile - A decoded file after placement (`IdentityMap.apply`)
 *
 * @remarks
 * A `subject` lands only through a relative literal reference, so every
 * subject-bearing resource without one is listed. A `requester` or
 * `performer` that is a `display` alone (a lab the report prints) is not.
 */
const collect = (placedFile: DecodedFile.DecodedFile): readonly Type[] =>
  DecodedFile.resources(placedFile).flatMap(({ key, resource }): readonly Type[] => {
    const missingSubject: readonly Type[] =
      'subject' in resource && resource.subject === null
        ? [MissingSubject({ mentioningResourceKey: key })]
        : []
    const dangling = Mention.of(resource)
      .filter((mention) => !landsOnDevice(mention.reference) && namesSomething(resource, mention))
      .map((mention): Type =>
        Dangling({
          mentioningResourceKey: key,
          mentionPath: mention.path,
          referenceAsWritten: mention.reference,
        })
      )
    return [...missingSubject, ...dangling]
  })

export { collect, is, match }
export type { Dangling, MissingSubject, Type }
