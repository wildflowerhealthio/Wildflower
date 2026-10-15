# AGENTS.md — apps/launcher/launcher-web

The launcher: the web app that manages a Wildflower server, published at
`/launcher/`. Its entry, `main-web` (`src/main-web.tsx`), hands
`session/consented-entry-root.tsx`'s `ConsentedEntryRoot` a `bootApp` that
redeems any sign-in and then calls `app-root.tsx`'s `buildAppTree`
(`RenderAppOptions`). It runs cross-origin to its API server and signs in by
SMART redirect (`sign-in.ts`), including when opened with a SMART launch, as
the base opens a server's launcher.

## Guardrails

- **Nothing boots before the telemetry consent dialog is answered.**
  `main-web` mounts `ConsentedEntryRoot`, a `TelemetryConsentGate` around
  the app with the shared `TELEMETRY_CONSENT_COPY`. The answer, kept in the
  page's `localStorage`, starts telemetry (`useConsentedTelemetryStart`, DSN
  `VITE_SENTRY_DSN_LAUNCHER_WEB`, tag `app: launcher-web`) and only then calls
  `bootApp`, once: the sign-in redemption, then `buildAppTree`. So before an
  answer no code is redeemed and no router, `QueryClient` or runtime exists,
  and a stored yes has Sentry running before the router is built. Tests:
  `session/consented-entry-root.test.tsx`.
- **Telemetry never starts from the build's env.** The runtime's
  `effectTelemetryLayer` is `telemetry-web`'s `consentedTelemetryLayer`. The
  `Sentry.*` calls in `app-root.tsx` run unconditionally; they do nothing
  until an answer starts Sentry. The settings screen's Telemetry row
  (`session/telemetry-settings-items.ts`) reads the answer by the gate's copy
  and reopens the dialog. The module-level colour-scheme listener is not
  telemetry, and runs before an answer.
- **The session is the server and its bearer, together.** authorization-react's
  `makeBearerAuthStateStore`, over the tab's `sessionStorage`, holds it: a
  sign-in writes both with `writeSession` (the redirect flow in `bootApp`, the
  only sign-in). The bearer
  lives in page memory and goes on `Unauthed`; the server is kept under
  `web-entry.ts`'s `SIGNED_IN_SERVER_KEY`, so a reload or the expiry bounce
  back to the landing signs back in to it. Every API request reads both
  lazily (`client/app-query-runtime.ts`'s `apiTransport`): it goes to the
  session's server with its bearer, and fails before any sign-in. `?server=`
  and a launch's `iss` choose only where the landing signs in
  (`web-entry.ts`'s `chosenServerUrl`). The settings screen's Logout row
  (`web-entry.ts`'s `logoutSettingsItem`) revokes the bearer at the session's
  server and clears the tab's `sessionStorage`. A 401, or a 403's "Request
  access", signs in again (`session/sign-in-again.ts`): the session goes
  `Unauthed`, keeping its server, and the landing signs back in to it with
  the page as `returnTo`. Tests:
  `authorization-react`'s `bearer-auth-state-store.test.ts`,
  `client/app-query-runtime.test.ts`, `web-entry.test.ts`, `app-root.test.tsx`,
  `scope-error-renderer.test.tsx`.
- **`main-web` takes a SMART launch at its root, with its own sign-in.**
  Like everything `bootApp` does, the launch waits for the consent answer, as
  it does in the SMART apps. `bootApp` reads `?iss=` (and the EHR's `launch`)
  with `authorization-core/smart-client`'s `searchAfterArrivingLaunch`, over
  `arrivingSmartLaunchFrom`, the reader the SMART apps share: it takes both
  out of the URL and points `?server=` at the server `iss` names
  (`normalizeServerUrl`), over any `?server=` already there. The landing then
  signs in to that server on arrival, as it does for any `?server=`, through
  `ConnectMenu`'s `autoConnect`, so the insecure-target refusal and the
  one-sign-in-at-a-time guard apply. Boot holds the launch once per page load
  (`ehrLaunchIn`, then `sign-in.ts`'s `unsentEhrLaunch`, as
  `RouterContext.ehrLaunch`), and the first sign-in to its server takes it, so
  no other sign-in carries it, even from a landing that mounts again:
  the authorization server accepts a launch once. It is not fhirclient's launch,
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
  on FHIR server that is not a Wildflower server (its SMART configuration
  does not list the `wildflower-server` capability). `sign-in.ts`'s
  `serverKindForSession` turns the redeemed session into
  `session/server-kind.ts`'s `ServerKind.PlainSmart`, carrying the FHIR base
  and the token response's `patient`; every other load passes
  `ServerKind.Wildflower()`. For `PlainSmart` the one page is its
  Home, at `/fhir-home` (`routes/fhir-home.tsx`), which offers no way to
  Settings, and the `_auth` and `/settings` gates redirect there
  (`session/home-path.ts`'s `homePathFor`) before any loader runs, so nothing
  calls a Wildflower-only endpoint. `/fhir-home` redirects a Wildflower session to
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

- **Access is managed in Wildflower Authorization**
  (`apps/authorization/authorization-web`), not here. The settings screen's
  Manage access row (`session/manage-access-settings-item.ts`) links out to
  the `management_endpoint` the session's server advertises in its SMART
  configuration; no settings route manages access. The approval routes
  (`/authorization/devices*`, `/authorization/oauth-consent/$id`) stay. Tests: `route-tree.test.ts`,
  `routes/settings.test.tsx`.

## References

- [Telemetry Explanation](../../../slices/telemetry/docs/Telemetry%20Explanation.md)
  — "The launcher"
- [Settings Fragments How-To](../../../docs/UI/Settings%20Fragments%20How-To.md)
- [apps/launcher/AGENTS.md](../AGENTS.md) — the folder this app sits in
- [apps/AGENTS.md](../../AGENTS.md)
