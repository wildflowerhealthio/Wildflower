import type { SmartRegistration } from '@wildflowerhealthio/fhir-r4-react/smart'
import type { SmartAppTelemetry } from '@wildflowerhealthio/smart-app-react'

/**
 * The scopes the Assistant asks for, the same for an EHR launch and a
 * standalone connect: EHR launch, the signed-in user, and every FHIR
 * interaction on every resource type (`system/*.cruds`). `system/` scopes
 * only, with no `launch/patient`: the reader picks the patient in the app
 * (`smart-app-react`'s `PatientPicker`), or "All patients". An EHR launch that
 * puts a patient in context opens on that patient.
 *
 * The grant, not this string, decides what the agent can do. This asks for
 * everything; the consent screen lets the Owner narrow it, and the agent is
 * held to what was granted.
 *
 * The seeded OAuth clients carry exactly this set — the production client
 * (the authorization server migration `0051_seed_assistant_client`) and the
 * debug-only `assistant-dev` client in `authorization-server-rust`'s
 * `seed_dev_app_clients` — so a scope added here alone fails `/authorize`
 * against a Wildflower host.
 *
 * The bare `launch` scope is formally EHR-context-only per the SMART App
 * Launch IG (a standalone launch has no EHR context to launch into);
 * sandboxes such as SmartHealthIT tolerate it, and it is kept on the
 * standalone connect as the sibling apps keep it. If a server rejects the
 * authorize request over it, dropping `launch` is the first thing to try.
 */
const ASSISTANT_SCOPE = 'launch openid fhirUser system/*.cruds'

/**
 * The OAuth client the build launches as, which depends on how it is served:
 *
 * - A **production** build is published to
 *   `https://assistant.wildflowerhealth.io/` and launches as the
 *   `assistant` tile's client, `9883d102933b1561e343cae5fd9f26eb`.
 * - The **vite dev server** (`vp run -F @wildflowerhealthio/assistant-web dev`, on the port
 *   `dev-app-ports.json` pins) launches as the `assistant-dev`
 *   tile's client, `17613ed083c9fded0178ed0c5ebf7cfe`.
 *
 * The ids are random (`openssl rand -hex 16`), not the tile ids. Either way
 * `clientId` equals the app row's `client_id`: a launch checks the caller's
 * grant against that client's scopes, and `/authorize` matches the redirect
 * against that client's registered URIs.
 */
const ASSISTANT_CLIENT_ID = import.meta.env.DEV
  ? '17613ed083c9fded0178ed0c5ebf7cfe'
  : '9883d102933b1561e343cae5fd9f26eb'

/**
 * SMART registration for every launch the app root starts: one its URL
 * carries (`iss` / `launch`, read off the URL by the app root) and the
 * standalone connect menu's, where the user picks the FHIR server. So `iss` is
 * not set here, and `redirectUri` (the app root) is computed at launch time
 * from the current origin.
 */
const smartRegistration: SmartRegistration = {
  clientId: ASSISTANT_CLIENT_ID,
  scope: ASSISTANT_SCOPE,
}

/**
 * Where this app's telemetry goes once the visitor consents to it: its own
 * Sentry project, whose DSN is the `VITE_SENTRY_DSN_ASSISTANT_WEB` build variable, with
 * `assistant-web` as the `app` tag. A build that sets no DSN reports nothing.
 */
const smartAppTelemetry: SmartAppTelemetry = {
  dsn: import.meta.env.VITE_SENTRY_DSN_ASSISTANT_WEB ?? '',
  app: 'assistant-web',
}

export { ASSISTANT_SCOPE, smartAppTelemetry, smartRegistration }
