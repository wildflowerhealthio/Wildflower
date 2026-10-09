import type { SmartLaunchConfig } from 'fhir-r4-react/smart'
import type { SmartAppTelemetry } from 'smart-app-react'

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
 *   `https://wildflowerhealth.io/web-trace-app/` and launched through the
 *   `web-trace-app` app row (apps migration
 *   `0005_first_party_apps_to_cloud`), whose client
 *   (`0006_rename_first_party_app_clients`) registers that absolute Pages URL as
 *   its redirect URI.
 * - The **vite dev server** (`vp run -F wildflower-web-trace dev`, on the port
 *   `slices/apps/dev-app-ports.json` pins) is launched through the debug-only
 *   `web-trace-app-dev` row (`apps-rust`'s `seed_dev_apps`) and its
 *   client (`gatekeeper-rust`'s `seed_dev_app_clients`), which registers the
 *   dev server's loopback root (`http://localhost:{port}/`) as its redirect.
 *
 * Either way `clientId` MUST equal the app row's `client_id`: a launch checks
 * the caller's grant against that client's scopes, and `/authorize` matches the
 * redirect against that client's registered URIs.
 *
 * The app root authorizes with it for every launch it starts: one its URL
 * carries (`iss` / `launch`, read off the URL by fhirclient) and the standalone
 * connect menu's, where the user picks the FHIR server. So `iss` is not set
 * here, and `redirectUri` (the app root) is computed at launch time from the
 * current origin.
 *
 * The bare `launch` scope is formally EHR-context-only per the SMART App
 * Launch IG (a standalone launch has no EHR context to launch into); sandboxes
 * such as SmartHealthIT tolerate it, and it is kept on the standalone connect
 * deliberately per the app's scope set. If a server rejects the authorize
 * request over it, dropping `launch` is the first thing to try.
 */
const smartRegistration: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: import.meta.env.DEV ? 'web-trace-app-dev' : 'web-trace-app',
  scope: 'launch openid fhirUser system/DocumentReference.read',
}

/**
 * Where this app's telemetry goes once the visitor consents to it: its own
 * Sentry project, whose DSN is the `VITE_SENTRY_DSN_WEB_TRACE` build variable, with
 * `web-trace` as the `app` tag. A build that sets no DSN reports nothing.
 */
const smartAppTelemetry: SmartAppTelemetry = {
  dsn: import.meta.env.VITE_SENTRY_DSN_WEB_TRACE ?? '',
  app: 'web-trace',
}

export { smartAppTelemetry, smartRegistration }
