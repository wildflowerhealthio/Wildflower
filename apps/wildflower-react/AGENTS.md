# AGENTS.md — apps/wildflower-react

The owner UI: the web app that manages a Wildflower server. One source tree,
two entries, each passing its platform's wiring to `app-root.tsx`'s
`buildAppTree` (`RenderAppOptions`):

- **`main-web`** (`src/main-web.tsx`) — the build published at `/app/`,
  cross-origin to the server `?server=` names. Signs in by SMART redirect and
  holds its bearer in page memory (`web-entry.ts`, `sign-in.ts`).
- **`main-tauri`** (`apps/wildflower-tauri/src/main.tsx`) — the Tauri host's
  webview, authenticated by the host. Calls `renderApp`.

## Guardrails

- **`main-web` boots nothing before the telemetry consent dialog is
  answered.** It mounts `session/web-entry-root.tsx`'s `WebEntryRoot`, a
  `TelemetryConsentGate` around the app. The answer starts telemetry
  (`useConsentedTelemetryStart`, DSN `VITE_SENTRY_DSN_WILDFLOWER_REACT`, tags
  `app: wildflower-react`, `entry: main-web`) and only then calls `bootApp`,
  once: the sign-in redemption, then `buildAppTree`. So before an answer no
  code is redeemed and no router, `QueryClient` or runtime exists, and a
  stored yes has Sentry running before the router is built. Tests:
  `session/web-entry-root.test.tsx`.
- **`main-web` never starts telemetry from the build's env.** It does not
  import `instrument.ts`, and its runtime's `effectTelemetryLayer` is
  `telemetry-web`'s `consentedTelemetryLayer`. The `Sentry.*` calls in
  `app-root.tsx`, `routes/_auth.tsx` and `session/token-timeout-retry.tsx`
  run unconditionally; they do nothing until an answer starts Sentry.
- **`main-tauri` starts telemetry without asking.** It imports
  `wildflower-react/instrument` (`initWebTelemetryFromEnv`, the shared
  `VITE_SENTRY_DSN`) and passes `webTelemetryLayerFromEnv()` as its
  `effectTelemetryLayer`. It mounts no consent gate, so the settings screen
  shows no Telemetry row there (`session/telemetry-settings-items.ts`).
- **The entry decides, not a branch on `entry`.** Platform differences reach
  the shared tree as `RenderAppOptions` fields (`effectTelemetryLayer`,
  `platformSettingsItems`, `platformTabs`,
  `redirectToDeviceLoginOnUnauthorized`), or as a provider the entry mounts
  (the consent gate).

## References

- [Telemetry Explanation](../../slices/telemetry/docs/Telemetry%20Explanation.md)
  — "The owner UI"
- [Settings Fragments How-To](../../docs/UI/Settings%20Fragments%20How-To.md)
- [apps/AGENTS.md](../AGENTS.md)
