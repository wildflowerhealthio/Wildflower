import type { SmartLaunchConfig } from 'fhir-r4-react/smart'

/**
 * SMART registration for this app. `clientId` MUST match the OAuth client
 * seeded in gatekeeper (`0004_seed_medication_sponsorship_client`), and the
 * scopes must be a subset of that client's allowed scopes: EHR launch + patient
 * context, then read the patient plus their MedicationRequests (and any
 * referenced Medication resources). The `system/` scopes support a launch with
 * no patient in context, where the app reads MedicationRequests across every
 * patient the granted scopes expose (see `app.tsx`).
 *
 * `iss` / `launch` are read from the launch URL by fhirclient, so they are not
 * set here; `redirectUri` is computed at launch time from the current origin.
 */
export const smartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: 'medication-sponsorship',
  scope:
    'launch openid fhirUser patient/Patient.read patient/MedicationRequest.read patient/Medication.read system/MedicationRequest.read system/Medication.read',
}
