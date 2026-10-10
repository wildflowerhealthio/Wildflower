import type { SmartLaunchConfig } from 'fhir-r4-react/smart'
import type { SmartAppTelemetry } from 'smart-app-react'

/**
 * The scopes the lifting app asks for, the same for an EHR launch and a
 * standalone connect: EHR launch, then read Patients, and read and write the
 * four resource types a lifter's program is stored as —
 * the training plan definition (`PlanDefinition`), the `ServiceRequest` per
 * exercise, a `Procedure` per workout and an `Observation` per set.
 *
 * SMART v2 letters: `crus` is create + read + update + search. Every write is
 * a `PUT /{type}/{client-minted id}` entry in one batch `Bundle` — an update
 * that creates the resource the first time — so a server that gates
 * update-as-create on `create` accepts it; the app never deletes. `system/`
 * only, with no `launch/patient`, as the sibling apps ask: the reader picks
 * the lifter in the app (`smart-app-react`'s `PatientPicker`; an EHR launch
 * that puts a patient in context opens on them), every search is scoped to
 * them with `patient=`, and every resource written names them as its
 * `subject` (a `PlanDefinition` names no one). "All patients" searches
 * unscoped and writes nothing.
 *
 * The OAuth clients this app launches through must allow exactly this set:
 * a scope added here alone fails `/authorize` against a Wildflower host.
 *
 * The bare `launch` scope is formally EHR-context-only per the SMART App
 * Launch IG (a standalone launch has no EHR context to launch into);
 * sandboxes such as SmartHealthIT tolerate it, and it is kept on the
 * standalone connect as the sibling apps keep it. If a server rejects the
 * authorize request over it, dropping `launch` is the first thing to try.
 */
const LIFTING_SCOPE =
  'launch openid fhirUser system/Patient.rs system/PlanDefinition.crus system/ServiceRequest.crus system/Procedure.crus system/Observation.crus'

/**
 * The OAuth client the build launches as, which depends on how it is served:
 *
 * - A **production** build is published to
 *   `https://wildflowerhealth.io/lifting/` and launches as the `lifting` tile's
 *   client, `bdf9fc5cb5a28c6683b49896b0ef8a75`.
 * - The **vite dev server** (`vp run -F lifting-web dev`, on the port
 *   `dev-app-ports.json` pins) launches as the `lifting-dev` tile's
 *   client, `8467e680a05f1e92e22864e923144e5a`.
 *
 * The ids are random (`openssl rand -hex 16`), not the tile ids. Either way
 * `clientId` equals the app row's `client_id`: a launch checks the caller's
 * grant against that client's scopes, and `/authorize` matches the redirect
 * against that client's registered URIs.
 */
const LIFTING_CLIENT_ID = import.meta.env.DEV
  ? '8467e680a05f1e92e22864e923144e5a'
  : 'bdf9fc5cb5a28c6683b49896b0ef8a75'

/**
 * SMART registration for every launch the app root starts: one its URL
 * carries (`iss` / `launch`, read off the URL by fhirclient) and the
 * standalone connect menu's, where the user picks the FHIR server. So `iss` is
 * not set here, and `redirectUri` (the app root) is computed at launch time
 * from the current origin.
 */
const smartRegistration: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: LIFTING_CLIENT_ID,
  scope: LIFTING_SCOPE,
}

/**
 * Where this app's telemetry goes once the visitor consents to it: its own
 * Sentry project, whose DSN is the `VITE_SENTRY_DSN_LIFTING_WEB` build
 * variable, with `lifting-app` as the `app` tag. A build that sets no DSN
 * reports nothing.
 */
const smartAppTelemetry: SmartAppTelemetry = {
  dsn: import.meta.env.VITE_SENTRY_DSN_LIFTING_WEB ?? '',
  app: 'lifting-app',
}

export { LIFTING_SCOPE, smartAppTelemetry, smartRegistration }
