import { Schema } from 'effect'
import { IdentifierAndReference, type ReferenceType } from 'fhir-r4/data-types'
import { localResourceId } from 'fhir-r4/identity'

/**
 * A person's Patient as the importer of one source keys it: the source system
 * it is adopted under and the id the source gave it — so a renderer for
 * another source can file its results on that same Patient.
 *
 * @remarks
 * Adoption (`fhir-r4/identity`'s `adoptResource`) stores a resource under
 * `localResourceId(system, 'Patient', originalId)` and writes every reference
 * to it as that local id plus the source's own id as `Reference.identifier`;
 * {@link referenceOf} spells the reference the same way, so a result pointed
 * at it reads exactly like one of the source's own resources.
 */
interface SourcePatient {
  /** The source system the Patient is adopted under (a `sid` URI). */
  readonly system: string
  /** The id the source gave the Patient (`Patient/<originalId>` in its own references). */
  readonly originalId: string
}

const decodeReference = Schema.decodeSync(IdentifierAndReference.ReferenceSchema)

/** The id the Patient is stored under once its source's import adopts it. */
const adoptedIdOf = (sourcePatient: SourcePatient): string =>
  localResourceId(sourcePatient.system, 'Patient', sourcePatient.originalId)

/**
 * A reference to the Patient, as adoption rewrites the source's own
 * `Patient/<originalId>`: the adopted id, with the source's id beside it as
 * `Reference.identifier`.
 */
const referenceOf = (sourcePatient: SourcePatient): ReferenceType =>
  decodeReference({
    reference: `Patient/${adoptedIdOf(sourcePatient)}`,
    identifier: { system: sourcePatient.system, value: sourcePatient.originalId },
  })

export { adoptedIdOf, referenceOf }
export type { SourcePatient }
