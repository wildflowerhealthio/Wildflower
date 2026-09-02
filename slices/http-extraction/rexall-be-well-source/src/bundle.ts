import { Schema } from 'effect'

import { Bundle, MedicationDispense, MedicationRequest } from 'fhir-stu3-as-r4/schemas'

/**
 * The concrete carebook STU3 searchset Bundles the Rexall tunnel
 * (`rexall-prd-tunnel.letsbewell.ca/…/fhir/stu3/…`) returns:
 *  - a list/detail bundle of `MedicationRequest`s (with contained `Medication`),
 *  - a bundle of `MedicationDispense`s,
 *  - a mixed bundle holding either resource type (discriminated on `resourceType`).
 *
 * These decode to the clean STU3 shapes. To decode straight to R4, wrap the
 * matching `R4FromStu3Schema` from `fhir-stu3-as-r4/schemas` in
 * {@link Bundle.searchsetBundle} instead.
 */
const MedicationRequestBundle = Bundle.searchsetBundle(MedicationRequest.Schema)

const MedicationDispenseBundle = Bundle.searchsetBundle(MedicationDispense.Schema)

/** Either dialect resource, discriminated on `resourceType`. */
const MedicationResource = Schema.Union(MedicationRequest.Schema, MedicationDispense.Schema)

const MedicationBundle = Bundle.searchsetBundle(MedicationResource)

export { MedicationRequestBundle, MedicationDispenseBundle, MedicationResource, MedicationBundle }
