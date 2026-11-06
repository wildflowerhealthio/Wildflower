import { Option, pipe, Struct } from 'effect'

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { type MedicationRequest, Practitioner } from '@wildflowerhealthio/fhir-r4/resources'

/**
 * The system Wildflower names a Rexall prescriber in when carebook gives only
 * their printed name: the name, trimmed and its whitespace collapsed
 * (`fhir-r4`'s `Practitioner.nameIdentifier`).
 *
 * @remarks
 * **Persisted wire format.** The key of every Practitioner a Rexall import
 * implies from a printed name, and so part of the id it is stored under.
 */
const REXALL_PRACTITIONER_NAME_SYSTEM =
  'https://wildflowerhealth.io/fhir/sid/rexall-be-well/practitioner-name'

/**
 * Whether a `requester` names its prescriber only by `display`: no literal
 * and no identifier, so nobody can link it.
 */
const isDisplayOnly = ({ reference, identifier }: IdentifierAndReference.ReferenceType): boolean =>
  reference === null && identifier === null

/**
 * The prescriber's printed name as their identity: a `requester` the dialect
 * names only by `display` becomes `fhir-r4`'s `Practitioner.tryReferenceFromName`
 * of that name in {@link REXALL_PRACTITIONER_NAME_SYSTEM}, and no `requester`
 * at all when the name is blank or absent.
 *
 * @remarks
 * Carebook may send `requester.agent` with an empty `reference` and the
 * prescriber's name, so the prescriber is known only by that name. A
 * `display`-only reference names an identity nobody can key; as a logical
 * reference to the name, the import stage implies one Practitioner for every
 * prescription that names it. A requester that already carries a literal or
 * an identifier is left as it is: a `Practitioner/<id>` carebook never serves
 * is detached to a logical reference by that id, which implies the
 * Practitioner the same way.
 */
const nameRequester = (
  requester: IdentifierAndReference.ReferenceType | null
): IdentifierAndReference.ReferenceType | null =>
  requester === null || !isDisplayOnly(requester)
    ? requester
    : pipe(
        Option.fromNullable(requester.display),
        Option.flatMap((name) =>
          Practitioner.tryReferenceFromName(REXALL_PRACTITIONER_NAME_SYSTEM, name)
        ),
        Option.getOrNull
      )

/** {@link nameRequester} on a `MedicationRequest`'s `requester`. */
const namePrescriber = (request: MedicationRequest.Type): MedicationRequest.Type =>
  Struct.evolve(request, { requester: nameRequester })

export { namePrescriber, REXALL_PRACTITIONER_NAME_SYSTEM }
