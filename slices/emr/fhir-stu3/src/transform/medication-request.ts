import type {
  MedicationRequest as R4MedicationRequest,
  MedicationRequestDispenseRequest as R4DispenseRequest,
} from 'fhir-r4/resources'

import type * as Stu3MedicationRequest from '../schemas/medication-request.ts'
import { emptyMedicationRequest, toQuantity } from './internal.ts'

/**
 * Transform a decoded carebook STU3 `MedicationRequest.dispenseRequest` into
 * the R4 backbone shape. The carebook `number-of-repeats-available`
 * modifierExtension rides through on `modifierExtension`, unchanged.
 */
const transformDispenseRequest = (
  dispenseRequest: Stu3MedicationRequest.DispenseRequestType
): typeof R4DispenseRequest.Schema.Type => ({
  id: dispenseRequest.id,
  extension: dispenseRequest.extension,
  modifierExtension: dispenseRequest.modifierExtension,
  initialFill: null,
  dispenseInterval: null,
  validityPeriod: dispenseRequest.validityPeriod,
  numberOfRepeatsAllowed: dispenseRequest.numberOfRepeatsAllowed,
  quantity: toQuantity(dispenseRequest.quantity),
  expectedSupplyDuration: dispenseRequest.expectedSupplyDuration,
  performer: null,
})

/**
 * Transform a decoded carebook STU3 `MedicationRequest` into the fhir-r4 slice's
 * decoded `MedicationRequest`. Deltas handled (see the epic ticket):
 *  - STU3 `requester.agent` → R4 `requester` reference (physician `display`
 *    carried through).
 *  - STU3 `context` → R4 `encounter`.
 *  - `status` / `intent` map through unchanged (STU3 members are a subset of
 *    R4's).
 *  - Contained `Medication` resources and all carebook extensions are carried
 *    verbatim (R4 permits arbitrary extensions), so no source data is dropped.
 *  - `subject` Patient reference kept as-is — the Rexall collector guarantees a
 *    matching local Patient exists.
 */
const transformMedicationRequest = (
  source: Stu3MedicationRequest.Type
): typeof R4MedicationRequest.Schema.Type => ({
  ...emptyMedicationRequest,
  id: source.id,
  meta: source.meta,
  implicitRules: source.implicitRules,
  language: source.language,
  text: source.text,
  // Contained STU3 Medication is structurally an R4 Medication (shared
  // datatypes), so it passes through untouched.
  contained: source.contained,
  extension: source.extension,
  modifierExtension: source.modifierExtension,
  identifier: source.identifier,
  status: source.status,
  intent: source.intent,
  medicationCodeableConcept: source.medicationCodeableConcept,
  medicationReference: source.medicationReference,
  subject: source.subject,
  encounter: source.context,
  authoredOn: source.authoredOn,
  requester: source.requester === null ? null : source.requester.agent,
  note: source.note,
  dispenseRequest:
    source.dispenseRequest === null ? null : transformDispenseRequest(source.dispenseRequest),
})

export { transformMedicationRequest, transformDispenseRequest }
