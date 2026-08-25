import type { SmartLaunchConfig } from 'fhir-r4-react/smart'

/**
 * SMART registration for this app.
 *
 * The scope set **carries writes**, which is what separates this app from the
 * Medications and Web Trace viewers it is otherwise shaped like: importing means
 * persisting the resources a captured session contained, each stamped with the
 * HAR archive it came from. The write set is exactly what the flow produces
 * today — the archive `DocumentReference` the confirm step uploads, plus the
 * `Patient` and `Observation` resources the registered `fhir-r4` collector
 * replays out of a capture. Widen it alongside any future collector or entity,
 * never ahead of one.
 *
 * `system/` rather than `patient/` because a HAR archive carries no `subject`:
 * it records a browsing session, not a clinical fact about a person, so it is
 * unreachable through patient context and a `patient/` scope would match
 * nothing.
 *
 * The scopes are **SMART v2 letter granularity**, tightened to exactly the FHIR
 * interactions the flow issues (never the mechanical v1 `.read`/`.write`
 * expansion):
 *
 * - `system/DocumentReference.rs` — read + search. The app **searches** the
 *   server for existing HAR archives (`DocumentReference.SearchByGet`) and reads
 *   one back by id when the user picks a server-held archive.
 * - `system/DocumentReference.u`, `system/Patient.u`, `system/Observation.u` —
 *   update only. Every write is a `PUT /{type}/{client-minted-uuid}` (the
 *   `.Update` endpoint / `fhir-r4`'s `upsertResource`), i.e. update-as-create:
 *   the app never issues a `POST` create (`.c`) or a `DELETE` (`.d`), so those
 *   letters are deliberately withheld. A server that gates update-as-create on
 *   `create` would reject these — negotiating scopes from the server's advertised
 *   capabilities is the dynamic-scope follow-up, not something to widen for
 *   pre-emptively here.
 *
 * `clientId` depends on how this build is being served, because the two ways it
 * is served are two different registrations:
 *
 * - A **production** build is published to
 *   <https://wildflowerhealth.io/importer-app/> and launched through the
 *   `importer-app` *cloud* app row (apps migration
 *   `0006_seed_wildflower_importer_app`), whose client
 *   (`0008_seed_wildflower_importer_client`) registers that absolute Pages URL as
 *   a redirect URI.
 * - The **vite dev server** (`vp run -F wildflower-importer dev`, on the port
 *   `slices/apps/dev-app-ports.json` pins) is launched through the debug-only
 *   `importer-app-dev` *self-hosted* row (`apps-rust`'s `seed_dev_apps`) and its
 *   client (`gatekeeper-rust`'s `seed_dev_app_clients`), which registers the
 *   app-relative `"/"` redirect that resolves against the loopback origin.
 *
 * Either way `clientId` MUST equal the app-registration id it is launched
 * through: the host's self-hosted redirect resolver looks an app up by
 * `client_id`, so the app-relative redirect only resolves when the two match.
 *
 * The scope string MUST equal the `allowed_scopes` JSON array in
 * `gatekeeper-rust`'s `0008_seed_wildflower_importer_client` migration, element
 * for element — a scope the app requests but the client is not allowed fails the
 * authorize step. Nothing enforces that across the TS/Rust boundary, so the
 * pairing is pinned here, in the migration's own comment, and in
 * [AGENTS.md](../AGENTS.md); the Rust assertion in `gatekeeper-rust`'s
 * `clients.rs` mirrors it on the other side. A **dev** build authorizes against
 * `importer-app-dev` instead (the `clientId` selected above), whose
 * `allowed_scopes` live in `gatekeeper-rust`'s `seed_dev_app_clients` and carry
 * this same set — widen that copy in step too, or `/authorize` fails only under
 * `vp run -F wildflower-importer dev`.
 *
 * `iss` / `launch` are read from the launch URL by fhirclient, so they are not
 * set here; `redirectUri` is computed at launch time from the current origin.
 */
const smartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: import.meta.env.DEV ? 'importer-app-dev' : 'importer-app',
  scope:
    'launch openid fhirUser system/DocumentReference.rs system/DocumentReference.u system/Patient.u system/Observation.u',
}

/**
 * SMART registration for the **standalone** connect flow (the `ConnectMenu` the
 * app root renders when the URL carries no OAuth callback), where the user picks
 * the FHIR server rather than the EHR naming it. Same `clientId` selection as
 * {@link smartConfig} — the standalone launch runs through the same registered
 * client, so its redirect URI (the app root) still resolves.
 *
 * The scopes match {@link smartConfig}'s write-carrying set: a standalone import
 * writes to the server the user chose, exactly as an EHR launch writes to the one
 * it was handed. Note the bare `launch` scope is formally EHR-context-only per
 * the SMART App Launch IG (a standalone launch has no EHR context to launch
 * into); sandboxes such as SmartHealthIT tolerate it, and it is kept here
 * deliberately per the app's scope set. If a server rejects the authorize
 * request over it, dropping `launch` is the first thing to try.
 */
const standaloneSmartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: import.meta.env.DEV ? 'importer-app-dev' : 'importer-app',
  scope:
    'launch openid fhirUser system/DocumentReference.rs system/DocumentReference.u system/Patient.u system/Observation.u',
}

export { smartConfig, standaloneSmartConfig }
