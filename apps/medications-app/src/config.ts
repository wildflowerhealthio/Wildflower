import type { SmartLaunchConfig } from 'fhir-r4-react/smart'

/**
 * SMART registration for the `medications-app` package. The scopes must be a
 * subset of the seeded OAuth client's allowed scopes: EHR launch + patient
 * context, then read the patient plus their MedicationRequests (and any
 * referenced Medication resources). The `system/` scopes support a launch with
 * no patient in context, where the app reads MedicationRequests across every
 * patient the granted scopes expose (see `app.tsx`).
 *
 * `clientId` depends on how this build is being served, because the two ways it
 * is served are two different registrations:
 *
 * - A **production** build is published to
 *   <https://wildflowerhealth.io/medications-app/> and launched through the
 *   `medications-app` *cloud* app row (apps migration
 *   `0005_first_party_apps_to_cloud`), whose client
 *   (`0006_rename_first_party_app_clients`) registers that absolute Pages URL as
 *   its redirect URI.
 * - The **vite dev server** (`vp run -F medications-app dev`, on the port `slices/apps/dev-app-ports.json` pins)
 *   is launched through the debug-only `medications-app-dev` *self-hosted* row
 *   (`apps-rust`'s `seed_dev_apps`) and its client
 *   (`gatekeeper-rust`'s `seed_dev_app_clients`), which registers the
 *   app-relative `"/"` redirect that resolves against the loopback origin.
 *
 * Either way `clientId` MUST equal the app-registration id it is launched
 * through: the host's self-hosted redirect resolver looks an app up by
 * `client_id`, so the app-relative redirect only resolves when the two match.
 * Changing either id takes a migration (production) or a dev-seed change.
 *
 * `iss` / `launch` are read from the launch URL by fhirclient, so they are not
 * set here; `redirectUri` is computed at launch time from the current origin.
 */
export const smartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: import.meta.env.DEV ? 'medications-app-dev' : 'medications-app',
  scope: 'launch openid fhirUser system/MedicationRequest.read system/Medication.read',
}

/**
 * SMART registration for the **standalone** connect flow (`connect.html` →
 * `ConnectMenu`), where the user picks the FHIR server rather than the EHR
 * naming it. Same `clientId` selection as {@link smartConfig} — the standalone
 * launch runs through the same registered client, so its redirect URI (the app
 * root) still resolves.
 *
 * The scopes match {@link smartConfig}'s. Note the bare `launch` scope is
 * formally EHR-context-only per the SMART App Launch IG (a standalone launch has
 * no EHR context to launch into); sandboxes such as SmartHealthIT tolerate it,
 * and it is kept here deliberately per the app's scope set. If a server rejects
 * the authorize request over it, dropping `launch` is the first thing to try.
 */
export const standaloneSmartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: import.meta.env.DEV ? 'medications-app-dev' : 'medications-app',
  scope: 'launch openid fhirUser system/MedicationRequest.read system/Medication.read',
}
