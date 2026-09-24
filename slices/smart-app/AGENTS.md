# AGENTS.md — slices/smart-app

The Wildflower chrome every self-hosted SMART app boots through. The SMART
wiring (the handshake, the self-hosted runtime, the launch-error contract, the
standalone-launch primitives) is `fhir-r4-react/smart`'s, and the Wildflower
look (header, footer, brand bar, landing layout) is `branding-react`'s. This
slice is where the two meet, so neither has to know about the other.

## Package roles

- **`smart-app-react`** — the only package. There is no `-core`: everything
  here is UI or DOM boot code.
  - `SmartAppRoot({ app, standalone, launched?, children })` — the app root.
  - `runSmartLaunchEntry({ launch, loadingMessage })` — the whole `launch.html`
    entry.
  - `ConnectMenu` and its `DEFAULT_SERVER_PRESET_GROUPS` — the standalone
    connect flow.

Consumers: `apps/medications-app` and `apps/importer-web` mount `SmartAppRoot`
and `runSmartLaunchEntry`; `apps/web-trace` still carries its own root and uses
only `ConnectMenu`.

## Booting an app

An app's two entries are each a few lines:

- `main.tsx` imports `react-tundraish/styles` (the design-system stylesheet
  stack, fonts included) before anything else, completes a GitHub Pages 404
  redirect (`restoreRedirectedUrl`), starts `addOsColorSchemeListener()`, and
  renders `<SmartAppRoot app="…" standalone={standaloneSmartConfig}><App /></SmartAppRoot>`.
- `launch-main.tsx` imports the same stylesheet module and calls
  `runSmartLaunchEntry`.

`branding-react`'s layout tokens arrive through its JS entry, so an app does not
import `branding-react/styles.css` itself.

## Guardrails

- **The branch is latched on mount.** `SmartAppRoot` reads
  `shouldCompleteSmartLaunch()` (or the `launched` prop) and `launchErrorFrom()`
  once, in `useState` initializers. fhirclient's `oauth2.ready()` strips
  `code`/`state` once the exchange completes, so re-reading the URL on a later
  render would flip a finished launch back to the connect menu under the
  authenticated app — and drop the failure banner a launch landed with.
- **One `QueryClient` per page, built by the shell.** `SmartAppRoot` builds it
  with `buildSmartQueryClient()` and provides it at the root, where the app's
  `useSmartHandshake` runs; the app hands that same instance to
  `buildSmartRouterContext`. See the `useSmartHandshake` guardrail in
  [slices/emr/AGENTS.md](../emr/AGENTS.md) for why the exchange must run once.
- **Redirect targets are derived from the page URL, in render.** Both the
  shell's `ConnectMenu` redirect and the launch page's are `new URL('.', href)`,
  so the bundle works at whatever origin and path it is served from, and no
  module reads `window` as a side effect of being imported.
- **A failed launch goes to the app root, never a dead end.** A rejected
  `authorizeSmartLaunch` on the launch page is handed to the app root through
  `launchErrorRedirect`, where `SmartAppRoot`'s `ErrorBanner` renders it; the
  contract is `fhir-r4-react/smart`'s `launch-error.ts`.
- **`ConnectMenu` probes before it connects, and `unreachable` ≠ `open`.** It
  renders inside `AppLanding` on the standalone branch: launch buttons grouped
  under each known server's name and address (`DEFAULT_SERVER_PRESET_GROUPS`)
  as hairline-separated blocks in the landing page's vocabulary, then a free-URL
  form. The free entry is validated with `normalizeServerUrl` in a plain
  `type="text"` input, never `type="url"` — HTML5 constraint validation would
  block the submit handler and mask the message. `startStandaloneLaunch`'s
  `unreachable` outcome is shown as a retryable error banner rather than
  connecting; why that must never degrade to `open` is the standalone-launch
  guardrail in [slices/emr/AGENTS.md](../emr/AGENTS.md).

## References

- [slices/emr/AGENTS.md](../emr/AGENTS.md) — the SMART primitives this slice
  builds on
- [slices/branding/AGENTS.md](../branding/AGENTS.md) — the chrome it renders,
  and "The app landing page"
