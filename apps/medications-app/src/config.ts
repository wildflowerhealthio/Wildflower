import type { SmartLaunchConfig } from 'fhir-r4-react/smart'
import type { SmartAppTelemetry } from 'smart-app-react'

/**
 * The scopes the medications app asks for, the same for an EHR launch and a
 * standalone connect: EHR launch, then read MedicationRequests (and any
 * referenced Medication resources) and Patients. `system/` scopes only, with
 * no `launch/patient`: the reader picks the patient in the app
 * (`smart-app-react`'s `PatientPicker`, which reads `Patient`; an EHR launch
 * that puts a patient in context opens on them), and the MedicationRequest
 * read is filtered with `patient=`, or unscoped for "All patients" (see
 * `app.tsx`).
 *
 * The seeded OAuth clients carry exactly this set — `medications-app`
 * (gatekeeper migration `0020_first_party_apps_pick_the_patient`) and the
 * debug-only `medications-app-dev` (`gatekeeper-rust`'s
 * `seed_dev_app_clients`, whose test reads this file) — so a scope added here
 * alone fails `/authorize` against a Wildflower host.
 *
 * The bare `launch` scope is formally EHR-context-only per the SMART App
 * Launch IG (a standalone launch has no EHR context to launch into);
 * sandboxes such as SmartHealthIT tolerate it, and it is kept on the
 * standalone connect as the sibling apps keep it. If a server rejects the
 * authorize request over it, dropping `launch` is the first thing to try.
 */
const MEDICATIONS_SCOPE =
  'launch openid fhirUser system/MedicationRequest.rs system/Medication.rs system/Patient.rs'

/**
 * SMART registration for the `medications-app` package, with
 * {@link MEDICATIONS_SCOPE}.
 *
 * `clientId` depends on how this build is being served, because the two ways it
 * is served are two different registrations:
 *
 * - A **production** build is published to
 *   `https://wildflowerhealth.io/medications-app/` and launched through the
 *   `medications-app` app row (apps migration
 *   `0005_first_party_apps_to_cloud`), whose client
 *   (`0006_rename_first_party_app_clients`) registers that absolute Pages URL as
 *   its redirect URI.
 * - The **vite dev server** (`vp run -F medications-app dev`, on the port
 *   `slices/apps/dev-app-ports.json` pins) is launched through the debug-only
 *   `medications-app-dev` row (`apps-rust`'s `seed_dev_apps`) and its
 *   client (`gatekeeper-rust`'s `seed_dev_app_clients`), which registers the
 *   dev server's loopback root (`http://localhost:{port}/`) as its redirect.
 *
 * Either way `clientId` MUST equal the app row's `client_id`: a launch checks
 * the caller's grant against that client's scopes, and `/authorize` matches the
 * redirect against that client's registered URIs.
 * Changing either id takes a migration (production) or a dev-seed change.
 *
 * The app root authorizes with it for every launch it starts: one its URL
 * carries (`iss` / `launch`, read off the URL by fhirclient) and the standalone
 * connect menu's, where the user picks the FHIR server. So `iss` is not set
 * here, and `redirectUri` (the app root) is computed at launch time from the
 * current origin.
 */
const smartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: import.meta.env.DEV ? 'medications-app-dev' : 'medications-app',
  scope: MEDICATIONS_SCOPE,
}

/**
 * Where this app's telemetry goes once the visitor consents to it: its own
 * Sentry project, whose DSN is the `VITE_SENTRY_DSN_MEDICATIONS_APP` build variable, with
 * `medications-app` as the `app` tag. A build that sets no DSN reports nothing.
 */
const smartAppTelemetry: SmartAppTelemetry = {
  dsn: import.meta.env.VITE_SENTRY_DSN_MEDICATIONS_APP ?? '',
  app: 'medications-app',
}

export { MEDICATIONS_SCOPE, smartAppTelemetry, smartConfig }
