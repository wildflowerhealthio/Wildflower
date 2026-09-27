import type { SmartLaunchConfig } from 'fhir-r4-react/smart'

/**
 * SMART registration for the standalone connect flow — the only way this app is
 * launched. The Pebble phone app opens the page from the watchapp's settings,
 * the user picks a FHIR server in the `ConnectMenu`, and the server's consent
 * screen picks the patient.
 *
 * The scopes are exactly what the watch needs and nothing more:
 *
 * - `launch/patient` — ask the server to pick a patient during consent and hand
 *   its id back in the token response. There is no bare `launch`: that scope is
 *   EHR-launch-only, and this app has no `launch.html`.
 * - `patient/Patient.r` — read that one patient back, so the settings page can
 *   show who the watch will record for before the user saves.
 * - `patient/Observation.c` — the watch's whole job: sync the steps, sleep and
 *   heart rate the Pebble records as Observations for that patient. The
 *   watch's PebbleKit JS uses the access token this page hands it, so whatever
 *   this scope set grants is what the watch can do.
 *
 * `clientId` depends on how this build is being served:
 *
 * - A **production** build is published to
 *   `https://wildflowerhealth.io/fhir-sync-pebble/` and authorizes as the
 *   `fhir-sync-pebble` client (gatekeeper migration
 *   `0017_seed_fhir_sync_pebble_client`), which registers that absolute URL.
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
  scope: 'launch/patient openid fhirUser patient/Patient.r patient/Observation.c',
}

export { standaloneSmartConfig }
