# AGENTS.md — apps/launcher/launcher-web

The launcher: the web app that manages a Wildflower server. One source tree,
two entries, each passing its platform's wiring to `app-root.tsx`'s
`buildAppTree` (`RenderAppOptions`) from the `bootApp` it hands
`session/consented-entry-root.tsx`'s `ConsentedEntryRoot`:

- **`main-web`** (`src/main-web.tsx`) — the build published at `/launcher/`,
  cross-origin to the server `?server=` names. Signs in by SMART redirect and
  holds its bearer in page memory (`web-entry.ts`, `sign-in.ts`), including
  when opened with a SMART launch, as the base opens a server's launcher.
- **`main-tauri`** — the wiring for a webview the host authenticates. No app
  mounts it: the Tauri host's webview mounts the servers base
  (`apps/host/servers/servers-react`) instead.

## Guardrails

- **Neither entry boots before the telemetry consent dialog is answered.**
  Each mounts `ConsentedEntryRoot` (exported as
  `launcher-web/consented-entry-root`), a `TelemetryConsentGate` around
  the app, with its own `entry` and dialog copy: `main-web` the shared
  `TELEMETRY_CONSENT_COPY`, `main-tauri` `branding-core`'s
  `WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY`. The answer, kept in the page's
  `localStorage`, starts telemetry (`useConsentedTelemetryStart`, DSN
  `VITE_SENTRY_DSN_LAUNCHER_WEB`, tags `app: wildflower-react` and
  `entry`) and only then calls `bootApp`, once: on `main-web` the sign-in
  redemption, then `buildAppTree`; on `main-tauri` `buildAppTree` alone. So
  before an answer no code is redeemed and no router, `QueryClient`, runtime
  or transport exists, and a stored yes has Sentry running before the router
  is built. Tests: `session/consented-entry-root.test.tsx`.
- **Neither entry starts telemetry from the build's env.** Each runtime's
  `effectTelemetryLayer` is `telemetry-web`'s `consentedTelemetryLayer`. The
  `Sentry.*` calls in `app-root.tsx`, `routes/_auth.tsx` and
  `session/token-timeout-retry.tsx` run unconditionally; they do nothing
  until an answer starts Sentry. The settings screen's Telemetry row
  (`session/telemetry-settings-items.ts`) reads the answer by the gate's copy
  and reopens the dialog. `main-tauri`'s module-level `configureRecovery`
  call and colour-scheme listener are not telemetry, and run before an
  answer.
- **The entry decides, not a branch on `entry`.** Platform differences reach
  the shared tree as `RenderAppOptions` fields (`effectTelemetryLayer`,
  `platformSettingsItems`, `platformTabs`, `platformBanner`,
  `redirectToDeviceLoginOnUnauthorized`, `serverKind`), or as a provider the
  entry mounts (the consent gate). `main-tauri` contributes the server status
  banner `<RootShell>` renders above every route and the Settings row for
  `/settings/server`; `main-web` passes `platformBanner: null`, since no host
  runs a server for it.
- **`main-web` takes a SMART launch at its root, with its own sign-in.**
  Like everything `bootApp` does, the launch waits for the consent answer, as
  it does in the SMART apps. `bootApp` reads `?iss=` (and the EHR's `launch`)
  with `gatekeeper-core/smart-client`'s `searchAfterArrivingLaunch`, over
  `arrivingSmartLaunchFrom`, the reader the SMART apps share: it takes both
  out of the URL and points `?server=` at the server `iss` names
  (`serverUrlNamedBy`), over any `?server=` already there. The landing then
  signs in to that server on arrival, as it does for any `?server=`, through
  `ConnectMenu`'s `autoConnect`, so the insecure-target refusal and the
  one-sign-in-at-a-time guard apply. Boot holds the launch once per page load
  (`ehrLaunchIn`, then `sign-in.ts`'s `unsentEhrLaunch`, as
  `RouterContext.ehrLaunch`), and the first sign-in to its server takes it, so
  no other sign-in carries it, even from a landing that mounts again:
  gatekeeper accepts a launch once. It is not fhirclient's launch,
  as in the SMART apps, because fhirclient keeps its token in
  `sessionStorage`, and the owner's bearer stays in page memory. A sign-in
  that fails on its return leg (a rejected launch among them) points
  `?server=` back at its server (`searchAfterReturnLeg`), so the landing
  shows the problem beside a "Sign in to …" for it. Every return leg loses
  the authorization response, the authorization server's RFC 9207 `iss`
  included (`searchWithoutAuthorizationResponse`), so that `iss` never reads
  as a launch. Tests: `web-entry.test.ts`,
  `sign-in.test.ts`, `routes/index.test.tsx`.
- **A plain SMART server gets only Home.** `main-web` can sign in to a SMART
  on FHIR server that is not a Wildflower server (discovery found its
  configuration at the URL itself, not under `/fhir-r4`). `sign-in.ts`'s
  `serverKindForSession` turns the redeemed session into
  `session/server-kind.ts`'s `ServerKind.PlainSmart`, carrying the FHIR base
  and the token response's `patient`; `main-tauri` and every other `main-web`
  load pass `ServerKind.Wildflower()`. For `PlainSmart`, `<TabBar>` renders
  only Home, at `/fhir-home` (`routes/fhir-home.tsx`), and the `_auth` and
  `/settings` gates redirect there before any loader runs, so nothing calls a
  Wildflower-only endpoint. `/fhir-home` redirects a Wildflower session to
  `/home` the same way (`session/auth-gated-route-options.ts`).
- **That Home launches every hosted SMART app against the server.** Its list
  is `branding-core`'s `smartAppLaunchPages`: every `APP_DESCRIPTIONS` entry
  that `launchesFromUrl`, at its root under the site root
  `siteRootFor('launcher', …)` derives from the page's origin and router basepath
  (a PR preview's own root, the canonical site otherwise). Each tile is a plain link to
  `fhir-r4-react/smart`'s `appLaunchUrl`: SMART Health IT's launcher EHR launch
  (with the session's patient) for one of the launcher's FHIR bases, a
  standalone `?iss=` launch for any other. The list is static; the page calls
  nothing on the server.

## References

- [Telemetry Explanation](../../../slices/telemetry/docs/Telemetry%20Explanation.md)
  — "The launcher"
- [Settings Fragments How-To](../../../docs/UI/Settings%20Fragments%20How-To.md)
- [apps/launcher/AGENTS.md](../AGENTS.md) — the folder this app sits in
- [apps/AGENTS.md](../../AGENTS.md)
