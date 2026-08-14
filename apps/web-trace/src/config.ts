import type { SmartLaunchConfig } from 'fhir-r4-react/smart'

/**
 * SMART registration for this app.
 *
 * The scope set is **read-only and deliberately so**: this is the app that reads
 * the rawest data on the device, and never writing is worth preserving as a
 * property of it rather than as a convention.
 *
 * `system/` rather than `patient/` because trace `DocumentReference`s carry no
 * `subject` (see `web-trace-core`'s codec traps) and so are not reachable
 * through patient context at all.
 *
 * `clientId` depends on how this build is being served, because the two ways it
 * is served are two different registrations:
 *
 * - A **production** build is published to
 *   <https://wildflower-health.io/web-trace-app/> and launched through the
 *   `web-trace-app` *cloud* app row (apps migration
 *   `0005_first_party_apps_to_cloud`), whose client
 *   (`0006_rename_first_party_app_clients`) registers that absolute Pages URL as
 *   its redirect URI.
 * - The **vite dev server** (`vp run -F wildflower-web-trace dev`, on the port
 *   `slices/apps/dev-app-ports.json` pins) is launched through the debug-only `web-trace-app-dev` *self-hosted*
 *   row (`apps-rust`'s `seed_dev_apps`) and its client (`gatekeeper-rust`'s
 *   `seed_dev_app_clients`), which registers the app-relative `"/"` redirect that
 *   resolves against the loopback origin.
 *
 * Either way `clientId` MUST equal the app-registration id it is launched
 * through: the host's self-hosted redirect resolver looks an app up by
 * `client_id`, so the app-relative redirect only resolves when the two match.
 *
 * `iss` / `launch` are read from the launch URL by fhirclient, so they are not
 * set here; `redirectUri` is computed at launch time from the current origin.
 */
export const smartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: import.meta.env.DEV ? 'web-trace-app-dev' : 'web-trace-app',
  scope: 'launch openid fhirUser system/DocumentReference.read',
}
