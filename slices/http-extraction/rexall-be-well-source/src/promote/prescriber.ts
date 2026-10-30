import { Option, pipe, Struct } from 'effect'

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { type MedicationRequest, Practitioner } from '@wildflowerhealthio/fhir-r4/resources'

/**
 * Whether a `requester` names its prescriber only by `display`: no literal
 * and no identifier, so nobody can link it.
 */
const isDisplayOnly = ({ reference, identifier }: IdentifierAndReference.ReferenceType): boolean =>
  reference === null && identifier === null

/**
 * The prescriber's printed name as their identity: a `requester` the dialect
 * names only by `display` becomes `fhir-r4`'s `Practitioner.tryReferenceFromName`
 * of that name, and no `requester` at all when the name is blank or absent.
 *
 * @remarks
 * Carebook sends `requester.agent` with an empty `reference` and the
 * prescriber's name, so the prescriber is known only by that name. A
 * `display`-only reference names an identity nobody can link; as a logical
 * reference to the name, the importer's identity map can link the prescriber to a
 * Practitioner on the device, and the same name from another source is the same
 * provider. A requester that already carries a literal or an identifier is left
 * as it is.
 */
const nameRequester = (
  requester: IdentifierAndReference.ReferenceType | null
): IdentifierAndReference.ReferenceType | null =>
  requester === null || !isDisplayOnly(requester)
    ? requester
    : pipe(
        Option.fromNullable(requester.display),
        Option.flatMap(Practitioner.tryReferenceFromName),
        Option.getOrNull
      )

/** {@link nameRequester} on a `MedicationRequest`'s `requester`. */
const namePrescriber = (request: MedicationRequest.Type): MedicationRequest.Type =>
  Struct.evolve(request, { requester: nameRequester })

export { namePrescriber }
