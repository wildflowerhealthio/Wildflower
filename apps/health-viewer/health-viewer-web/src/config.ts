import type { SmartLaunchConfig } from '@wildflowerhealthio/fhir-r4-react/smart'
import type { SmartAppTelemetry } from '@wildflowerhealthio/smart-app-react'

/**
 * The scopes the health viewer asks for, the same for an EHR launch and a
 * standalone connect: EHR launch, then read Patients, Observations and
 * MedicationRequests. `system/` scopes only, with no `launch/patient`: the
 * reader picks the patient in the app (`smart-app-react`'s `PatientPicker`),
 * and every read is filtered by the patient picked, or unscoped for "All
 * patients" (see `app.tsx`). An EHR launch that puts a patient in context
 * opens on that patient.
 *
 * The seeded OAuth clients carry exactly this set — the production client
 * (gatekeeper migration `0022_seed_health_viewer_app_client`) and the
 * debug-only `health-viewer-dev` client in `gatekeeper-rust`'s
 * `seed_dev_app_clients` — so a scope added here alone fails `/authorize`
 * against a Wildflower host.
 *
 * The bare `launch` scope is formally EHR-context-only per the SMART App
 * Launch IG (a standalone launch has no EHR context to launch into);
 * sandboxes such as SmartHealthIT tolerate it, and it is kept on the
 * standalone connect as the sibling apps keep it. If a server rejects the
 * authorize request over it, dropping `launch` is the first thing to try.
 */
const HEALTH_VIEWER_SCOPE =
  'launch openid fhirUser system/Observation.rs system/MedicationRequest.rs system/Patient.rs'

/**
 * The OAuth client the build launches as, which depends on how it is served:
 *
 * - A **production** build is published to
 *   `https://wildflowerhealth.io/health-viewer/` and launches as the
 *   `health-viewer` tile's client, `474e103de61f9141c4b640d59bfa130e`.
 * - The **vite dev server** (`vp run -F @wildflowerhealthio/health-viewer-web dev`, on the port
 *   `dev-app-ports.json` pins) launches as the `health-viewer-dev`
 *   tile's client, `e7efc7c805f5f8f640bb3b3d48a2d7aa`.
 *
 * The ids are random (`openssl rand -hex 16`), not the tile ids. Either way
 * `clientId` equals the app row's `client_id`: a launch checks the caller's
 * grant against that client's scopes, and `/authorize` matches the redirect
 * against that client's registered URIs.
 */
const HEALTH_VIEWER_CLIENT_ID = import.meta.env.DEV
  ? 'e7efc7c805f5f8f640bb3b3d48a2d7aa'
  : '474e103de61f9141c4b640d59bfa130e'

/**
 * SMART registration for every launch the app root starts: one its URL
 * carries (`iss` / `launch`, read off the URL by fhirclient) and the
 * standalone connect menu's, where the user picks the FHIR server. So `iss` is
 * not set here, and `redirectUri` (the app root) is computed at launch time
 * from the current origin.
 */
const smartRegistration: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: HEALTH_VIEWER_CLIENT_ID,
  scope: HEALTH_VIEWER_SCOPE,
}

/**
 * Where this app's telemetry goes once the visitor consents to it: its own
 * Sentry project, whose DSN is the `VITE_SENTRY_DSN_HEALTH_VIEWER_WEB` build variable, with
 * `health-viewer-web` as the `app` tag. A build that sets no DSN reports nothing.
 */
const smartAppTelemetry: SmartAppTelemetry = {
  dsn: import.meta.env.VITE_SENTRY_DSN_HEALTH_VIEWER_WEB ?? '',
  app: 'health-viewer-web',
}

export { HEALTH_VIEWER_SCOPE, smartAppTelemetry, smartRegistration }
