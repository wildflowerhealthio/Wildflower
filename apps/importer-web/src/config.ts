import type { SmartLaunchConfig } from 'fhir-r4-react/smart'
import type { SmartAppTelemetry } from 'smart-app-react'

/**
 * SMART registration for this app.
 *
 * The scope set **carries writes**, which is what separates this app from the
 * Medications and Web Trace viewers it is otherwise shaped like: importing means
 * persisting the resources a captured session contained, each stamped with the
 * HAR archive it came from. The auto-extracted write set is the archive
 * `DocumentReference` the confirm step uploads, plus the `Patient` and
 * `Observation` resources the registered `fhir-r4` source replays out of a
 * capture; the remaining types (`Practitioner`, `DiagnosticReport`,
 * `Medication`, `MedicationRequest`, `MedicationDispense`, `ServiceRequest`,
 * `ImagingStudy`) reach the store only through a resource the reviewer
 * hand-authors or edits into one of those types in the preview's inline JSON
 * editor — the grant runs slightly ahead of the extractors so the review can
 * write any handled type without a scope change.
 *
 * `system/` rather than `patient/` because a HAR archive carries no `subject`:
 * it records a browsing session, not a clinical fact about a person, so it is
 * unreachable through patient context and a `patient/` scope would match
 * nothing.
 *
 * The scopes are **SMART v2 letter granularity**, `.cruds` (create + read +
 * update + delete + search) on every FHIR resource type the importer handles —
 * `DocumentReference`, `Patient`, `Observation`, `Practitioner`,
 * `DiagnosticReport`, `Medication`, `MedicationRequest`, `MedicationDispense`,
 * `ServiceRequest`, `ImagingStudy`:
 *
 * - The app **searches** the server for existing HAR archives
 *   (`DocumentReference.SearchByGet`) and reads one back by id when the user
 *   picks a server-held archive.
 * - Every write is a `PUT /{type}/{client-minted-uuid}` (the `.Update` endpoint /
 *   `fhir-r4`'s `upsertResource`), i.e. update-as-create. The full `.cruds`
 *   grant deliberately includes `create` and `delete` even though the flow
 *   issues neither today, so a server that gates update-as-create on `create`
 *   accepts the writes and the set has room to grow without a scope change.
 *
 * `clientId` depends on how this build is being served, because the two ways it
 * is served are two different registrations:
 *
 * - A **production** build is published to
 *   `https://wildflowerhealth.io/importer-app/` and launched through the
 *   `importer-app` app row (apps migration
 *   `0006_seed_wildflower_importer_app`), whose client
 *   (`0008_seed_wildflower_importer_client`) registers that absolute Pages URL as
 *   a redirect URI.
 * - The **vite dev server** (`vp run -F wildflower-importer dev`, on the port
 *   `slices/apps/dev-app-ports.json` pins) is launched through the debug-only
 *   `importer-app-dev` row (`apps-rust`'s `seed_dev_apps`) and its
 *   client (`gatekeeper-rust`'s `seed_dev_app_clients`), which registers the
 *   dev server's loopback root (`http://localhost:{port}/`) as its redirect.
 *
 * Either way `clientId` MUST equal the app row's `client_id`: a launch checks
 * the caller's grant against that client's scopes, and `/authorize` matches the
 * redirect against that client's registered URIs.
 *
 * The scope string MUST equal the `allowed_scopes` JSON array the
 * `gatekeeper-rust` migrations seed for `importer-app` — originally
 * `0008_seed_wildflower_importer_client`, widened by
 * `0009_widen_importer_client_write_scopes` (broadens every type to `.cruds` and
 * adds `Practitioner`, `DiagnosticReport`, `Medication`, `MedicationRequest`,
 * `MedicationDispense`, `ServiceRequest`, and `ImagingStudy` writes;
 * `0015_repair_importer_client_write_scopes` re-applies it on an install that
 * skipped it) — element
 * for element: a scope the app requests but the client is not allowed fails the
 * authorize step. Nothing enforces that across the TS/Rust boundary, so the
 * pairing is pinned here, in the migration's own comment, and in
 * [AGENTS.md](../AGENTS.md); the Rust assertion in `gatekeeper-rust`'s
 * `clients.rs` mirrors it on the other side. A **dev** build authorizes against
 * `importer-app-dev` instead (the `clientId` selected above), whose
 * `allowed_scopes` live in `gatekeeper-rust`'s `seed_dev_app_clients` and carry
 * this same set — widen that copy in step too, or `/authorize` fails only under
 * `vp run -F wildflower-importer dev`.
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
  clientId: import.meta.env.DEV ? 'importer-app-dev' : 'importer-app',
  scope:
    'launch openid fhirUser system/DocumentReference.cruds system/Patient.cruds system/Observation.cruds system/Practitioner.cruds system/DiagnosticReport.cruds system/Medication.cruds system/MedicationRequest.cruds system/MedicationDispense.cruds system/ServiceRequest.cruds system/ImagingStudy.cruds',
}

/**
 * Where this app's telemetry goes once the visitor consents to it: its own
 * Sentry project, whose DSN is the `VITE_SENTRY_DSN_IMPORTER_WEB` build variable, with
 * `importer-web` as the `app` tag. A build that sets no DSN reports nothing.
 */
const smartAppTelemetry: SmartAppTelemetry = {
  dsn: import.meta.env.VITE_SENTRY_DSN_IMPORTER_WEB ?? '',
  app: 'importer-web',
}

export { smartAppTelemetry, smartRegistration }
