import type { SmartLaunchConfig } from 'fhir-r4-react/smart'

/**
 * SMART registration for this app. `clientId` MUST match the OAuth client
 * seeded in gatekeeper (`0005_seed_wildflower_web_trace_client`) and the app
 * registration seeded in apps (`0004_seed_wildflower_web_trace_app`) — for a
 * self-hosted app the OAuth `client_id` is the app id.
 *
 * The scope set is **read-only and deliberately so**: this is the app that reads
 * the rawest data on the device, and never writing is worth preserving as a
 * property of it rather than as a convention.
 *
 * `system/` rather than `patient/` because trace `DocumentReference`s carry no
 * `subject` (see `web-trace-core`'s codec traps) and so are not reachable
 * through patient context at all.
 *
 * `iss` / `launch` are read from the launch URL by fhirclient, so they are not
 * set here; `redirectUri` is computed at launch time from the current origin.
 */
export const smartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: 'wildflower-web-trace',
  scope: 'launch openid fhirUser system/DocumentReference.read',
}
