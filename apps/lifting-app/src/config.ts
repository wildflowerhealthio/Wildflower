import type { SmartLaunchConfig } from 'fhir-r4-react/smart'
import type { SmartAppTelemetry } from 'smart-app-react'

/**
 * The scopes the lifting app asks for, the same for an EHR launch and a
 * standalone connect: EHR launch + patient context, then read the patient and
 * read and write the four resource types a lifter's program is stored as —
 * the training plan definition (`PlanDefinition`), the `ServiceRequest` per
 * exercise, a `Procedure` per workout and an `Observation` per set.
 *
 * SMART v2 letters: `crus` is create + read + update + search. Every write is
 * a `PUT /{type}/{client-minted id}` entry in one batch `Bundle` — an update
 * that creates the resource the first time — so a server that gates
 * update-as-create on `create` accepts it; the app never deletes. `system/`
 * rather than `patient/`, as the sibling apps ask: every search is scoped to
 * the launch's patient with `patient=`, and every resource written names that
 * patient as its `subject` (a `PlanDefinition` names no one).
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
  'launch launch/patient openid fhirUser system/Patient.rs system/PlanDefinition.crus system/ServiceRequest.crus system/Procedure.crus system/Observation.crus'

/**
 * The OAuth client the build launches as, which depends on how it is served:
 *
 * - A **production** build is published to
 *   `https://wildflowerhealth.io/lifting-app/` and launches as `lifting-app`.
 * - The **vite dev server** (`vp run -F lifting-app dev`, on the port
 *   `slices/apps/dev-app-ports.json` pins) launches as `lifting-app-dev`.
 *
 * Either way `clientId` equals the app-registration id it is launched through:
 * the host's redirect resolver looks an app up by `client_id`.
 */
const LIFTING_CLIENT_ID = import.meta.env.DEV ? 'lifting-app-dev' : 'lifting-app'

/**
 * SMART registration for the EHR launch (`launch.html`). `iss` / `launch` are
 * read from the launch URL by fhirclient, so they are not set here;
 * `redirectUri` is computed at launch time from the current origin.
 */
const smartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: LIFTING_CLIENT_ID,
  scope: LIFTING_SCOPE,
}

/**
 * SMART registration for the **standalone** connect flow (the `ConnectMenu` the
 * app root renders when the URL carries no OAuth callback), where the user
 * picks the FHIR server rather than the EHR naming it. The same client and
 * scopes as {@link smartConfig}, so its redirect URI (the app root) resolves
 * the same way, and `launch/patient` asks the server to pick the lifter.
 */
const standaloneSmartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: LIFTING_CLIENT_ID,
  scope: LIFTING_SCOPE,
}

/**
 * Where this app's telemetry goes once the visitor consents to it: its own
 * Sentry project, whose DSN is the `VITE_SENTRY_DSN_LIFTING_APP` build
 * variable, with `lifting-app` as the `app` tag. A build that sets no DSN
 * reports nothing.
 */
const smartAppTelemetry: SmartAppTelemetry = {
  dsn: import.meta.env.VITE_SENTRY_DSN_LIFTING_APP ?? '',
  app: 'lifting-app',
}

export { LIFTING_SCOPE, smartAppTelemetry, smartConfig, standaloneSmartConfig }
