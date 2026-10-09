import type { SmartLaunchConfig } from 'fhir-r4-react/smart'
import type { SmartAppTelemetry } from 'smart-app-react'

/**
 * The scopes the loader asks for, the same for an EHR launch and a standalone
 * connect: `launch` for the EHR launch, the `openid` / `fhirUser` identity
 * pair, and create + update on every resource type the importers write, which
 * is what a snapshot holds (its entries are importer output).
 *
 * `.cu` and nothing more: the loader only writes, each resource a batch `PUT`
 * under its own id, and a `PUT` is an update that creates what is not there.
 * `system/` rather than `patient/`, because a snapshot holds several people's
 * records and the loader writes them all.
 *
 * The seeded OAuth client carries exactly this set — the debug-only
 * `synthetic-data-app-dev` client in `gatekeeper-rust`'s
 * `seed_dev_app_clients`, whose test reads this string out of this file — so
 * a scope added here alone fails `/authorize` against a Wildflower host.
 */
const SYNTHETIC_DATA_SCOPE =
  'launch openid fhirUser system/Patient.cu system/Practitioner.cu system/DocumentReference.cu system/Observation.cu system/DiagnosticReport.cu system/Medication.cu system/MedicationRequest.cu system/MedicationDispense.cu system/ServiceRequest.cu system/ImagingStudy.cu'

/**
 * The OAuth client the build launches as, which depends on how it is served:
 *
 * - A **production** build is published to
 *   `https://wildflowerhealth.io/synthetic-data-app/` and launches as
 *   `synthetic-data-app`.
 * - The **vite dev server** (`vp run -F synthetic-data-app dev`, on the port
 *   `slices/apps/dev-app-ports.json` pins) is launched through the debug-only
 *   `synthetic-data-app-dev` row (`apps-rust`'s `seed_dev_apps`) and its
 *   client (`gatekeeper-rust`'s `seed_dev_app_clients`), which registers the
 *   dev server's loopback root as its redirect.
 *
 * Either way `clientId` equals the app row's `client_id`: a launch checks the
 * caller's grant against that client's scopes, and `/authorize` matches the
 * redirect against that client's registered URIs.
 */
const SYNTHETIC_DATA_CLIENT_ID = import.meta.env.DEV
  ? 'synthetic-data-app-dev'
  : 'synthetic-data-app'

/**
 * SMART registration for every launch the app root starts: one its URL
 * carries (`iss` / `launch`, read off the URL by fhirclient) and the
 * standalone connect menu's, where the user picks the FHIR server. So `iss` is
 * not set here, and `redirectUri` (the app root) is computed at launch time
 * from the current origin.
 */
const smartRegistration: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: SYNTHETIC_DATA_CLIENT_ID,
  scope: SYNTHETIC_DATA_SCOPE,
}

/**
 * Where the snapshot the page starts with is published: the data repo
 * (`wildflowerhealthio/synthetic-data`) deploys it to GitHub Pages.
 */
const PUBLISHED_SNAPSHOT_ADDRESS = 'https://wildflowerhealthio.github.io/synthetic-data/'

/**
 * Where this app's telemetry goes once the visitor consents to it: its own
 * Sentry project, whose DSN is the `VITE_SENTRY_DSN_SYNTHETIC_DATA_APP` build
 * variable, with `synthetic-data-app` as the `app` tag. A build that sets no
 * DSN reports nothing.
 */
const smartAppTelemetry: SmartAppTelemetry = {
  dsn: import.meta.env.VITE_SENTRY_DSN_SYNTHETIC_DATA_APP ?? '',
  app: 'synthetic-data-app',
}

export { PUBLISHED_SNAPSHOT_ADDRESS, smartAppTelemetry, smartRegistration, SYNTHETIC_DATA_SCOPE }
