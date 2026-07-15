import type { MedicationDispense as R4MedicationDispense } from 'fhir-r4/resources'

import type * as Stu3MedicationDispense from '../schemas/medication-dispense.ts'
import { emptyMedicationDispense, toQuantity } from './internal.ts'

/**
 * Transform a decoded carebook STU3 `MedicationDispense` into the fhir-r4
 * slice's decoded `MedicationDispense`. STU3 `context` maps to R4 `context`;
 * `authorizingPrescription`, `quantity`, `daysSupply`, `whenPrepared`,
 * `whenHandedOver`, and `status` map through directly (STU3 status members are
 * a subset of R4's). `SimpleQuantity` values are widened to R4 `Quantity`. All
 * carebook extensions are carried verbatim.
 */
const transformMedicationDispense = (
  source: Stu3MedicationDispense.Type
): typeof R4MedicationDispense.Schema.Type => ({
  ...emptyMedicationDispense,
  id: source.id,
  meta: source.meta,
  implicitRules: source.implicitRules,
  language: source.language,
  text: source.text,
  contained: source.contained,
  extension: source.extension,
  modifierExtension: source.modifierExtension,
  identifier: source.identifier,
  status: source.status,
  medicationCodeableConcept: source.medicationCodeableConcept,
  medicationReference: source.medicationReference,
  subject: source.subject,
  context: source.context,
  authorizingPrescription: source.authorizingPrescription,
  quantity: toQuantity(source.quantity),
  daysSupply: toQuantity(source.daysSupply),
  whenPrepared: source.whenPrepared,
  whenHandedOver: source.whenHandedOver,
})

export { transformMedicationDispense }
