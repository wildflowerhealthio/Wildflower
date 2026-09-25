import { Array as Arr, Option, pipe, Schema } from 'effect'
import { CodeableConcept, IdentifierAndReference } from 'fhir-r4/data-types'
import { Medication as FhirMedication, type MedicationRequest } from 'fhir-r4/resources'

/**
 * The three places a `MedicationRequest` names its drug: the
 * `medicationCodeableConcept` and `medicationReference` halves of the
 * `medication[x]` choice, and a Medication carried inline in `contained`.
 *
 * @remarks
 * `medication[x]` is typed `any` on the decoded resource (fhir-r4 resolves
 * choice datatypes through a registry) and `contained` is untyped passthrough.
 * Each is taken as `unknown` and decoded through fhir-r4's own schema: the
 * `medication[x]` slots already hold *decoded* values, so they go through the
 * type side (`Schema.typeSchema`); `contained` entries are raw wire JSON, so they
 * go through the full wire schema.
 */

const decodeConcept = Schema.decodeUnknownOption(Schema.typeSchema(CodeableConcept.Schema))
const decodeReference = Schema.decodeUnknownOption(
  Schema.typeSchema(IdentifierAndReference.ReferenceSchema)
)
const decodeContainedMedication = Schema.decodeUnknownOption(FhirMedication.Schema)

/** `medicationCodeableConcept`, or `null` when the request names its drug another way. */
const medicationConceptOf = (
  request: MedicationRequest.Type
): typeof CodeableConcept.Schema.Type | null => {
  const slot: unknown = request.medicationCodeableConcept
  return Option.getOrNull(decodeConcept(slot))
}

/** `medicationReference`, or `null` when the request names its drug another way. */
const medicationReferenceOf = (
  request: MedicationRequest.Type
): IdentifierAndReference.ReferenceType | null => {
  const slot: unknown = request.medicationReference
  return Option.getOrNull(decodeReference(slot))
}

/** A `contained` entry as an R4 Medication, or `None` when it is anything else. */
const asContainedMedication = (entry: unknown): Option.Option<FhirMedication.Type> =>
  decodeContainedMedication(entry)

/** Whether a contained Medication is the one with `id`. */
const hasId =
  (id: string) =>
  (medication: FhirMedication.Type): boolean =>
    medication.id === id

/**
 * The Medication carried inline in `MedicationRequest.contained`.
 *
 * @returns The contained Medication a `#id` `medicationReference` points at, or
 *   the first contained Medication when the reference is absent or external;
 *   `null` when none decodes.
 *
 * @remarks
 * An entry that does not decode as an R4 `Medication` is skipped, not fatal.
 */
const containedMedicationOf = (request: MedicationRequest.Type): FhirMedication.Type | null => {
  const medications = Arr.filterMap(request.contained, asContainedMedication)
  return pipe(
    Option.fromNullable(medicationReferenceOf(request)?.reference),
    Option.flatMap(IdentifierAndReference.fragmentIdOf),
    Option.flatMap((containedId) => Arr.findFirst(medications, hasId(containedId))),
    Option.orElse(() => Arr.head(medications)),
    Option.getOrNull
  )
}

export { containedMedicationOf, medicationConceptOf, medicationReferenceOf }
