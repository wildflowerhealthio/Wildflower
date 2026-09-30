import type { SmartLaunchConfig } from 'fhir-r4-react/smart'

/**
 * SMART registration for the standalone connect flow — the only way this app is
 * launched. The Pebble phone app opens the page from the watchapp's settings,
 * the user picks a FHIR server in the `ConnectMenu`, and after signing in picks
 * the patient on the settings page itself.
 *
 * The scopes are exactly what the page and the watch need and nothing more:
 *
 * - `openid`, `fhirUser` — the same identity pair every first-party app asks
 *   for.
 * - `system/Patient.rs` — read and search the server's patients: the settings
 *   page lists them, with their names and birth dates, for the user to pick the
 *   one the watch will record for.
 * - `system/Observation.cu` — the watch's whole job: sync the steps, sleep and
 *   heart rate the Pebble records as Observations for the picked patient.
 *   `u` as well as `c` because the sync's transaction PUTs each Observation
 *   under a deterministic id, and a PUT is an update. The
 *   watch's PebbleKit JS uses the access token this page hands it, so whatever
 *   this scope set grants is what the watch can do.
 *
 * `system/` rather than `patient/`, as the other first-party apps: the patient
 * is picked on this page, after the grant, so the token carries no patient
 * context and a `patient/` scope would reach nothing. There is no
 * `launch/patient` for the same reason, and no bare `launch`: that scope is
 * EHR-launch-only, and this app has no `launch.html`.
 *
 * `clientId` depends on how this build is being served:
 *
 * - A **production** build is published to
 *   `https://wildflowerhealth.io/fhir-sync-pebble/` and authorizes as the
 *   `fhir-sync-pebble` client (gatekeeper migration
 *   `0017_seed_fhir_sync_pebble_client`, scopes widened by `0018`), which
 *   registers that absolute URL.
 * - The **vite dev server** (`vp run -F fhir-sync-pebble-web dev`, on the port
 *   `slices/apps/dev-app-ports.json` pins) authorizes as the debug-only
 *   `fhir-sync-pebble-dev` client (`gatekeeper-rust`'s `seed_dev_app_clients`),
 *   which registers `http://localhost:{port}/`.
 *
 * The scope string MUST equal the client's `allowed_scopes` element for
 * element: a scope the app requests but the client is not allowed fails
 * `/authorize`. Nothing spans the TS/Rust boundary to check it, so the pairing
 * is held by mirrors — this comment, the migration's header, the vector asserted
 * in `gatekeeper-rust`'s `db/clients.rs`, and the dev client in `seeding.rs`.
 * Change one, change all four.
 */
const standaloneSmartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: import.meta.env.DEV ? 'fhir-sync-pebble-dev' : 'fhir-sync-pebble',
  scope: 'openid fhirUser system/Patient.rs system/Observation.cu',
}

/**
 * The `sessionStorage` key the Pebble phone app's `return_to` is kept under
 * across the SMART login: `main.tsx` keeps it before the login navigates away,
 * and `App` recalls it once the callback lands.
 */
const RETURN_TO_STORAGE_KEY = 'fhir-sync-pebble:return-to'

export { RETURN_TO_STORAGE_KEY, standaloneSmartConfig }
