import type { SmartLaunchConfig } from '@wildflowerhealthio/fhir-r4-react/smart'
import type { SmartAppTelemetry } from '@wildflowerhealthio/smart-app-react'

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
 * The seeded OAuth clients carry exactly this set — the production client
 * (gatekeeper migration `0020_first_party_apps_pick_the_patient`) and the
 * debug-only dev client (`gatekeeper-rust`'s
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
 * The OAuth client the build launches as, which depends on how it is served:
 *
 * - A **production** build is published to
 *   `https://wildflowerhealth.io/medications/` and launches as the
 *   `medications` tile's client, `9769f8b274370708d0d3ebb2e3e59b7c`, which
 *   registers that absolute Pages URL as its redirect URI.
 * - The **vite dev server** (`vp run -F @wildflowerhealthio/medications-web dev`, on the port
 *   `dev-app-ports.json` pins) launches as the `medications-dev`
 *   tile's client, `4be2ee91360733fdcb99b43a3822de5f` (`gatekeeper-rust`'s
 *   `seed_dev_app_clients`), which registers the dev server's loopback root
 *   (`http://localhost:{port}/`) as its redirect.
 *
 * The ids are random (`openssl rand -hex 16`), not the tile ids. Either way
 * `clientId` MUST equal the app row's `client_id`: a launch checks the caller's
 * grant against that client's scopes, and `/authorize` matches the redirect
 * against that client's registered URIs. Changing either id takes a migration
 * (production) or a dev-seed change.
 */
const MEDICATIONS_CLIENT_ID = import.meta.env.DEV
  ? '4be2ee91360733fdcb99b43a3822de5f'
  : '9769f8b274370708d0d3ebb2e3e59b7c'

/**
 * SMART registration for every launch the app root starts, with
 * {@link MEDICATIONS_SCOPE}: one its URL carries (`iss` / `launch`, read off
 * the URL by fhirclient) and the standalone connect menu's, where the user
 * picks the FHIR server. So `iss` is not set here, and `redirectUri` (the app
 * root) is computed at launch time from the current origin.
 */
const smartRegistration: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: MEDICATIONS_CLIENT_ID,
  scope: MEDICATIONS_SCOPE,
}

/**
 * Where this app's telemetry goes once the visitor consents to it: its own
 * Sentry project, whose DSN is the `VITE_SENTRY_DSN_MEDICATIONS_WEB` build variable, with
 * `medications-web` as the `app` tag. A build that sets no DSN reports nothing.
 */
const smartAppTelemetry: SmartAppTelemetry = {
  dsn: import.meta.env.VITE_SENTRY_DSN_MEDICATIONS_WEB ?? '',
  app: 'medications-web',
}

export { MEDICATIONS_SCOPE, smartAppTelemetry, smartRegistration }
