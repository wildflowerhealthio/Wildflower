import type { SmartLaunchConfig } from 'fhir-r4-react/smart'

/**
 * SMART registration for this app.
 *
 * The scope set **carries writes**:
 *
 * - `system/Patient.rs` — the launch names the patient the plan is for.
 * - `system/CarePlan.cruds`, `system/Goal.cruds` — the plan is a `CarePlan`
 *   referencing one `Goal` per exercise, both searched to show the plan and
 *   written when a plan is saved or a progression applied.
 * - `system/Observation.cruds` — each logged attempt is an `Observation`,
 *   searched by `based-on=CarePlan/<id>` and written when a session is logged.
 *
 * SMART v2 letter granularity: `.cruds` (create + read + update + delete +
 * search). Every write is a `PUT /{type}/{client-minted id}` entry in one
 * batch `Bundle` (update-as-create); `create` and `delete` are granted even
 * though the flow issues neither, so a server that gates update-as-create on
 * `create` accepts the writes.
 *
 * `system/` rather than `patient/`, as every other first-party app's client
 * requests (`apps/importer-web/src/config.ts`, `apps/medications-app`'s
 * `config.ts`). The app scopes every search itself with `patient=<id>` (the
 * launch's patient) and writes that patient as every resource's `subject`. How
 * the server evaluates scopes is in the emr-rust Capability Statement
 * (`slices/emr/emr-rust/docs/`).
 *
 * `clientId` depends on how this build is being served, because the two ways it
 * is served are two different registrations:
 *
 * - A **production** build is launched through the `lifting-app` *cloud* app
 *   row and its OAuth client, which register the published Pages URL
 *   (`https://wildflowerhealth.io/lifting-app/`) as a redirect URI.
 * - The **vite dev server** (`vp run -F wildflower-lifting dev`, on the port
 *   `slices/apps/dev-app-ports.json` pins) is launched through a debug-only
 *   `lifting-app-dev` row and its client, which registers the app-relative
 *   `"/"` redirect that resolves against the loopback origin.
 *
 * Both registrations are seeded: the `lifting-app` row by `apps-rust`
 * migration `0010_seed_lifting_app` and its client by `gatekeeper-rust`
 * migration `0019_seed_lifting_app_client`; the `lifting-app-dev` row and
 * client by the debug-only dev seeds (`apps-rust`'s `dev_seed.rs` and
 * `gatekeeper-rust`'s `seed_dev_app_clients`).
 *
 * Either way `clientId` MUST equal the app-registration id it is launched
 * through: the host's self-hosted redirect resolver looks an app up by
 * `client_id`, so the app-relative redirect only resolves when the two match.
 *
 * The `allowed_scopes` migration `0019_seed_lifting_app_client` seeds for the
 * `lifting-app` client (and `seed_dev_app_clients` for the `lifting-app-dev`
 * one) MUST equal, element for element, the union
 * of this string's scopes and {@link standaloneSmartConfig}'s — that is, these
 * plus `launch/patient`. A scope the app requests but the client is not
 * allowed fails the authorize step, and one the client allows but neither
 * launch requests is an unused grant. Nothing enforces that across the TS/Rust
 * boundary, so the pairing is pinned here, in the seed's own comment, and in
 * [AGENTS.md](../AGENTS.md); change one, change all of them.
 *
 * `iss` / `launch` are read from the launch URL by fhirclient, so they are not
 * set here; `redirectUri` is computed at launch time from the current origin.
 */
const smartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: import.meta.env.DEV ? 'lifting-app-dev' : 'lifting-app',
  scope:
    'launch openid fhirUser system/Patient.rs system/CarePlan.cruds system/Goal.cruds system/Observation.cruds',
}

/**
 * SMART registration for the **standalone** connect flow (the `ConnectMenu` the
 * app root renders when the URL carries no OAuth callback), where the user picks
 * the FHIR server rather than the EHR naming it. Same `clientId` selection as
 * {@link smartConfig} — the standalone launch runs through the same registered
 * client, so its redirect URI (the app root) still resolves.
 *
 * The scopes are {@link smartConfig}'s plus `launch/patient`, which asks the
 * server to pick a patient during the standalone authorize — there is no EHR to
 * name one, and a plan is always some patient's. The bare `launch` scope is
 * formally EHR-context-only per the SMART App Launch IG; it is kept as the other
 * first-party apps keep it, and dropping it is the first thing to try if a
 * server rejects the authorize request over it.
 */
const standaloneSmartConfig: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'> = {
  clientId: import.meta.env.DEV ? 'lifting-app-dev' : 'lifting-app',
  scope:
    'launch launch/patient openid fhirUser system/Patient.rs system/CarePlan.cruds system/Goal.cruds system/Observation.cruds',
}

export { smartConfig, standaloneSmartConfig }
