import { Code } from 'fhir-r4/data-types'
import type { IdentifierAndReference, Quantity, SimpleQuantity } from 'fhir-r4/data-types'
import type { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'

/** An all-empty R4 `Reference`, used as a placeholder for required references. */
const emptyReference: IdentifierAndReference.ReferenceType = {
  id: null,
  extension: [],
  display: null,
  identifier: null,
  reference: null,
  type: null,
}

/**
 * Widen a carebook `SimpleQuantity` (no `comparator`, unbranded `code`) to the
 * R4 `Quantity` the fhir-r4 dispense-request / dispense fields expect: add the
 * absent `comparator` slot and brand `code` as a FHIR `code` primitive.
 */
const toQuantity = (
  simple: typeof SimpleQuantity.Schema.Type | null
): typeof Quantity.Schema.Type | null =>
  simple === null
    ? null
    : {
        id: simple.id,
        extension: simple.extension,
        code: simple.code === null ? null : Code.make(simple.code),
        comparator: null,
        system: simple.system,
        unit: simple.unit,
        value: simple.value,
      }

/**
 * All-empty R4 `MedicationRequest`. Every field carries its "absent" value so
 * the transform only has to overwrite the slots the carebook payload populates.
 * `status` / `intent` / `subject` are required and always overwritten, so their
 * placeholders here are never observed.
 */
const emptyMedicationRequest: typeof MedicationRequest.Schema.Type = {
  resourceType: 'MedicationRequest',
  id: null,
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  status: 'unknown',
  statusReason: null,
  intent: 'order',
  category: [],
  priority: null,
  doNotPerform: null,
  reportedBoolean: null,
  reportedReference: null,
  medicationCodeableConcept: null,
  medicationReference: null,
  subject: emptyReference,
  encounter: null,
  supportingInformation: [],
  authoredOn: null,
  requester: null,
  performer: null,
  performerType: null,
  recorder: null,
  reasonCode: [],
  reasonReference: [],
  instantiatesCanonical: [],
  instantiatesUri: [],
  basedOn: [],
  groupIdentifier: null,
  courseOfTherapyType: null,
  insurance: [],
  note: [],
  dosageInstruction: [],
  dispenseRequest: null,
  substitution: null,
  priorPrescription: null,
  detectedIssue: [],
  eventHistory: [],
}

/** All-empty R4 `MedicationDispense`; see {@link emptyMedicationRequest}. */
const emptyMedicationDispense: typeof MedicationDispense.Schema.Type = {
  resourceType: 'MedicationDispense',
  id: null,
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  partOf: [],
  status: 'unknown',
  statusReasonCodeableConcept: null,
  statusReasonReference: null,
  category: null,
  medicationCodeableConcept: null,
  medicationReference: null,
  subject: null,
  context: null,
  supportingInformation: [],
  performer: [],
  location: null,
  authorizingPrescription: [],
  type: null,
  quantity: null,
  daysSupply: null,
  whenPrepared: null,
  whenHandedOver: null,
  destination: null,
  receiver: [],
  note: [],
  dosageInstruction: [],
  substitution: null,
  detectedIssue: [],
  eventHistory: [],
}

export { emptyMedicationRequest, emptyMedicationDispense, emptyReference, toQuantity }
