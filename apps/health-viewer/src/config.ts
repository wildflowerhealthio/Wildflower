import type { SmartLaunchConfig } from 'fhir-r4-react/smart'
import type { SmartAppTelemetry } from 'smart-app-react'

/**
 * The scopes the health viewer asks for, the same for an EHR launch and a
 * standalone connect: EHR launch, then read Patients, Observations and
 * MedicationRequests. `system/` scopes only, with no `launch/patient`: the
 * reader picks the patient in the app (`smart-app-react`'s `PatientPicker`),
 * and every read is filtered by the patient picked, or unscoped for "All
 * patients" (see `app.tsx`). An EHR launch that puts a patient in context
 * opens on that patient.
 *
 * The seeded OAuth clients carry exactly this set — the debug-only
 * `health-viewer-app-dev` client in `gatekeeper-rust`'s `seed_dev_app_clients`
 * — so a scope added here alone fails `/authorize` against a Wildflower host.
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
 *   `https://wildflowerhealth.io/health-viewer-app/` and launches as
 *   `health-viewer-app`.
 * - The **vite dev server** (`vp run -F health-viewer-app dev`, on the port
 *   `slices/apps/dev-app-ports.json` pins) is launched through the debug-only
 *   `health-viewer-app-dev` cloud row (`apps-rust`'s `seed_dev_apps`) and its
 *   client (`gatekeeper-rust`'s `seed_dev_app_clients`), which registers the
 *   dev server's loopback root as its redirect.
 *
 * Either way `clientId` equals the app-registration id it is launched through:
 * the host's redirect resolver looks an app up by `client_id`.
 */
const HEALTH_VIEWER_CLIENT_ID = import.meta.env.DEV ? 'health-viewer-app-dev' : 'health-viewer-app'

/**
 * SMART registration for the EHR launch (`launch.html`). `iss` / `launch` are
 * read from the launch URL by fhirclient, so they are not set here;
 * `redirectUri` is computed at launch time from the current origin.
 */
const smartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: HEALTH_VIEWER_CLIENT_ID,
  scope: HEALTH_VIEWER_SCOPE,
}

/**
 * SMART registration for the **standalone** connect flow (the `ConnectMenu` the
 * app root renders when the URL carries no OAuth callback), where the user
 * picks the FHIR server rather than the EHR naming it. The same client and
 * scopes as {@link smartConfig}, so its redirect URI (the app root) resolves
 * the same way.
 */
const standaloneSmartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: HEALTH_VIEWER_CLIENT_ID,
  scope: HEALTH_VIEWER_SCOPE,
}

/**
 * Where this app's telemetry goes once the visitor consents to it: its own
 * Sentry project, whose DSN is the `VITE_SENTRY_DSN_HEALTH_VIEWER` build variable, with
 * `health-viewer` as the `app` tag. A build that sets no DSN reports nothing.
 */
const smartAppTelemetry: SmartAppTelemetry = {
  dsn: import.meta.env.VITE_SENTRY_DSN_HEALTH_VIEWER ?? '',
  app: 'health-viewer',
}

export { HEALTH_VIEWER_SCOPE, smartAppTelemetry, smartConfig, standaloneSmartConfig }
