import type { SmartLaunchConfig } from 'fhir-r4-react/smart'

/**
 * The scopes the synthetic data loader asks for, the same for an EHR launch
 * and a standalone connect: importer-web's write scopes (`.cruds`, SMART v2
 * letter granularity) for each resource type a published data set holds —
 * what the pharmacy HAR, lab, Pebble and DICOM imports write — so a load can
 * write anything an import could have. `Medication`, which importer-web also
 * grants for resources a reviewer hand-authors, is left out: no import writes
 * one. `system/` because a load writes records for people other than any
 * patient in context.
 *
 * The seeded OAuth clients carry exactly this set — the debug-only
 * `synthetic-data-app-dev` client in `gatekeeper-rust`'s
 * `seed_dev_app_clients` — so a scope added here alone fails `/authorize`
 * against a Wildflower host.
 *
 * The bare `launch` scope is formally EHR-context-only per the SMART App
 * Launch IG (a standalone launch has no EHR context to launch into);
 * sandboxes such as SmartHealthIT tolerate it, and it is kept on the
 * standalone connect as the sibling apps keep it. If a server rejects the
 * authorize request over it, dropping `launch` is the first thing to try.
 */
const SYNTHETIC_DATA_SCOPE =
  'launch openid fhirUser system/DocumentReference.cruds system/Patient.cruds system/Observation.cruds system/Practitioner.cruds system/DiagnosticReport.cruds system/MedicationRequest.cruds system/MedicationDispense.cruds system/ServiceRequest.cruds system/ImagingStudy.cruds'

/**
 * The OAuth client the build launches as, which depends on how it is served:
 *
 * - A **production** build is published to
 *   `https://wildflowerhealth.io/synthetic-data-app/` and launches as
 *   `synthetic-data-app`.
 * - The **vite dev server** (`vp run -F synthetic-data-app dev`, on the port
 *   `slices/apps/dev-app-ports.json` pins) is launched through the debug-only
 *   `synthetic-data-app-dev` cloud row (`apps-rust`'s `seed_dev_apps`) and its
 *   client (`gatekeeper-rust`'s `seed_dev_app_clients`), which registers the
 *   dev server's loopback root as its redirect.
 *
 * Either way `clientId` equals the app-registration id it is launched through:
 * the host's redirect resolver looks an app up by `client_id`.
 */
const SYNTHETIC_DATA_CLIENT_ID = import.meta.env.DEV
  ? 'synthetic-data-app-dev'
  : 'synthetic-data-app'

/**
 * SMART registration for the EHR launch (`launch.html`). `iss` / `launch` are
 * read from the launch URL by fhirclient, so they are not set here;
 * `redirectUri` is computed at launch time from the current origin.
 */
const smartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: SYNTHETIC_DATA_CLIENT_ID,
  scope: SYNTHETIC_DATA_SCOPE,
}

/**
 * SMART registration for the **standalone** connect flow (the `ConnectMenu` the
 * app root renders when the URL carries no OAuth callback), where the user
 * picks the FHIR server rather than the EHR naming it. The same client and
 * scopes as {@link smartConfig}, so its redirect URI (the app root) resolves
 * the same way.
 */
const standaloneSmartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: SYNTHETIC_DATA_CLIENT_ID,
  scope: SYNTHETIC_DATA_SCOPE,
}

export { SYNTHETIC_DATA_SCOPE, smartConfig, standaloneSmartConfig }
