import type { SmartLaunchConfig } from 'fhir-r4-react/smart'

/**
 * SMART registration for the `medications-app` package. `clientId` MUST match
 * the OAuth client seeded in gatekeeper
 * (`0004_seed_wildflower_medication_client`), and the scopes must be a subset
 * of that client's allowed scopes: EHR launch + patient context, then read the
 * patient plus their MedicationRequests (and any referenced Medication
 * resources). The `system/` scopes support a launch with no patient in context,
 * where the app reads MedicationRequests across every patient the granted
 * scopes expose (see `app.tsx`).
 *
 * `clientId` is `wildflower-medication` rather than the package name: it is
 * both the seeded OAuth client id and the seeded app id, and the redirect
 * resolver requires those two to be equal, so changing it takes a migration.
 *
 * `iss` / `launch` are read from the launch URL by fhirclient, so they are not
 * set here; `redirectUri` is computed at launch time from the current origin.
 */
export const smartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: 'wildflower-medication',
  scope: 'launch openid fhirUser system/MedicationRequest.read system/Medication.read',
}
