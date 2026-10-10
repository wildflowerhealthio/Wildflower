import type { MedicationRequest } from '@wildflowerhealthio/fhir-r4/resources'

/**
 * A decoded `MedicationRequest` as the FHIR server returns it: `id` is always
 * present. The same shape `fhir-r4`'s `withMandatoryId` decodes to.
 */
type MedicationRequestWithId = Omit<MedicationRequest.Type, 'id'> & { readonly id: string }

export type { MedicationRequestWithId }
