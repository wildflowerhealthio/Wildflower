# Learnings Inbox

A running log of non-obvious insights discovered during agent sessions. Triage into `Strategies` or a specific reference doc periodically.

_Last triaged 2026-07-04 — durable lessons were promoted to `Strategies.md`, testing- and Effect-tagged entries moved to `docs/Testing` / `docs/Effect`, and entries about removed code (Expo/React Native, Jest, the interop slice) were dropped. Git history preserves everything removed._

<!-- Append new entries below this line -->

## Scalar's browser defaults reach third parties unless turned off

`@scalar/api-reference` in its `web` layout (what `createApiReference` gives you) defaults `proxyUrl` to `https://proxy.scalar.com` — every "send" against a non-local target is routed through Scalar's hosted proxy, bearer token included — and `withDefaultFonts: true` pulls webfonts from `fonts.scalar.com`. Vendoring the npm package instead of the CDN script does not change either. `apps/wildflower-server-docs` sets `proxyUrl: ''` and `withDefaultFonts: false` and asserts both in `configuration.test.ts`; copy that if another page ever embeds Scalar.

## A default JSON import inlines the whole file, named imports tree-shake

`import config from './tauri-shared-config.json'` bakes the entire document — every unrelated field and comment — into the bundle even when one field is read. `import { loopback_hostname, loopback_port } from …` lets rolldown drop the rest. Worth doing whenever a shared config file is imported into a page that ships publicly.

## Renaming a diesel-seeded row id means deleting its child payload first

`self_hosted_app_configurations.id` (and every per-kind apps payload table) is a
FK onto `app_registrations(id)` with `ON DELETE CASCADE` and **no `ON UPDATE`
action**, and every pooled connection runs with `PRAGMA foreign_keys = ON`. So an
`UPDATE app_registrations SET id = …` while a payload row still references the old
id fails the constraint — and a failed migration aborts `SqliteAppsStore::open`,
taking the whole registry down. Order the statements payload-delete → registration
rename → new payload insert (see apps migration `0005_first_party_apps_to_cloud`).

## A dev-only seeded row cannot be a migration — but it must run before `setup_apps`

Migrations are embedded, run unconditionally, and are tracked by version, so
anything a migration writes exists in release databases too. Debug-only rows
therefore have to be a runtime seed behind `#[cfg(debug_assertions)]` (module-level
gating, not just the call site, or a release build still compiles the code). The
non-obvious constraint: `setup_apps` materializes the self-hosted catalogue once
and the host binds one loopback listener per row from that snapshot, so a dev seed
that runs _after_ it gets no listener. Seeding on its own `SqliteAppsStore` before
`setup_apps` is what makes the rows both migrated and bound.

## `vp pack` (tsdown/rolldown) cannot import binary assets — use a data-URL TS module

`import iconSrc from './assets/app-icon.png'` fails with "stream did not contain valid UTF-8" because tsdown reads every import as text. The workaround is a generated TypeScript module exporting the PNG as a `data:image/png;base64,...` string. At 128x128 the base64 adds ~22 KB to the bundle, acceptable for a single icon. The `branding-react` slice uses this pattern for its `src/assets/app-icon.ts`; the regeneration command is documented in the file's header comment.

## A self-hosted app's OAuth `client_id` must equal its app id; a cloud app's must not rely on it

The host's `SelfHostedRedirectResolver` resolves an app-relative redirect URI
(`"/"`) by looking the app up **by `client_id`** and requiring the row to be
self-hosted. Flipping an app to `kind = cloud` therefore silently breaks its
app-relative redirect — it resolves to nothing and matches no request (fail-closed,
so it looks like a rejected `redirect_uri` rather than a config error). A cloud app
needs an absolute redirect URI registered instead.

## Wrapping one slice's `HttpClient` separately still keeps the request-time credentialed-fetch tag

`apps/wildflower-react`'s `router-context.ts` now gives the FHIR slice its **own**
addressed transport (`prependApiBaseUrl(httpClientLayer, FhirResourcesApiPrefix)`,
so the de-prefixed typed client's `/Patient` becomes `/fhir-r4/Patient`) while every
other slice shares the base transport. That looked like it might drop the `wf_auth`
cookie, because `credentialedFetchLayer` (`FetchHttpClient.RequestInit` = `{ credentials: 'include' }`)
is not in the FHIR sub-layer's build scope. It doesn't: `FetchHttpClient` reads that
tag from the **request-time fiber context**, not at layer build, and `runAuthed`
provides the whole composed `runtimeLayer` (which still merges `credentialedFetchLayer`)
to every effect it runs — so the cookie rides the FHIR reads regardless of which
transport layer constructed the client. When splitting a shared `HttpClient` per
consumer, check whether the behaviour you care about is a build-time or a
request-time concern before assuming the split loses it.

## Adding `tsc` to a SMART app's build script fails on other packages' sources

`apps/importer-web` (and the other SMART apps) set `customConditions: ["source"]`
in their tsconfig so `tsc` and the bundler agree on the `QueryClient` type. A
side effect is that a package-local `tsc` also typechecks every workspace
package's raw source under **this app's** compiler options — e.g.
`erasableSyntaxOnly: true` rejects syntax in `kitchen-sink`. The build script
stays `vp build` only; typechecking comes from the workspace-wide `vp check`,
which is CI's gate.

## A URL-derived render decision must be latched on mount, not a default parameter

`launched = shouldCompleteSmartLaunch()` as a React default parameter re-reads
`window.location` on every render. fhirclient's `oauth2.ready()` calls
`history.replaceState` to strip `code`/`state` once the token exchange completes
(`replaceBrowserHistory` is on by default), so any later re-render flips the gate
and unmounts the authenticated app. Read the URL once in a `useState` initializer
(`useState(() => prop ?? shouldCompleteSmartLaunch())`); `apps/importer-web`'s
`AppRoot` is the worked example, with a re-render test that pins the latch.

## Source-only `exports` with no `default` condition work for workspace apps

`medications-app`'s `package.json` exports `{ ".": { "source": "./src/app-root.tsx" } }` with no `default` condition. `vp install`, `vp run pack`, `vp build`, and `vp check` all tolerate this: the `source` condition is sufficient for workspace-internal resolution and Vite's dev/build pipelines. A `default` pointing at a `dist/` entry is only needed if a built consumer outside the workspace resolves the package. This pattern is useful for app packages that export a seam for aggregator-shell composition but have no standalone library build.

## Migrating an app to branding-react chrome: stylesheet import order matters

When adding `branding-react/styles.css` to an app's `main.tsx`, it must come
_after_ `react-tundraish/styles.css` and _before_ the app's own `tokens.css` /
`global.css`. Order matters for override precedence only — a later `:root`
block wins for a same-named token — not for `var()` references (custom
properties resolve at computed-value time, so the layout tokens' use of
tundraish's `--space-N` ramps works regardless of sheet order). The existing `tokens.css`
values for `--content-max-width`, `--page-padding-x`, `--header-height`, and
`--radius-pill` must be removed — they are now supplied by `branding-react` and
duplicating them risks silent drift.

## `web-trace`'s `customConditions: ["source"]` blocks a `tsc` build step

`apps/web-trace`'s tsconfig sets `customConditions: ["source"]` so `tsc` and the
bundler agree on which copy of `QueryClient` a slice's router context refers to.
Under that condition a package-local `tsc` also re-typechecks other workspace
packages' sources under this app's strict compiler options (notably
`erasableSyntaxOnly: true`), which fails on code this app does not own (e.g.
`kitchen-sink`'s `two-step-external-schema.ts`). Typechecking comes from
`vp check`, which resolves the same way the bundler does; the `build` script
stays `vp build` with no `tsc` step.

## Color-scheme helpers live in react-tundraish, not in each app

`applyColorScheme`, `addOsColorSchemeListener`, and the `ColorScheme` type are
exported from `react-tundraish`. They translate the OS `prefers-color-scheme`
media query (or a bridge-relayed scheme) into the `data-color-scheme` attribute
that the stylesheet keys its dark palette off. Previously five near-identical
copies lived in individual apps; import from `react-tundraish` instead of
creating a new local copy.

### Egress allowlist changes do not reach a running session

**Discovered during**: claude/medication-interaction-checking-mxcbbl (DDInter data fetch)
**Learning**: Adding a host to the environment's network policy mid-session did not unblock it — the egress gateway kept answering 403 to CONNECT for `ddinter.scbdd.com`. Treat the policy as fixed at container start: allowlist first, then start a fresh session (or have the user commit the files). `curl -sS "$HTTPS_PROXY/__agentproxy/status"` shows `recentRelayFailures` with the denied host, which is the quickest way to tell a policy denial from a flaky download.
**Suggested destination**: Strategies

### `vp test --config <pkg>/vite.config.ts` from the repo root finds no tests

**Discovered during**: claude/medication-interaction-checking-mxcbbl
**Learning**: The `javascript-testing-expert` skill suggests `vp test --config <pkg>/vite.config.ts` to run one package's suite, but from the repo root that resolves the package's relative `test.include` (`src/**/*.test.ts`) against the root and reports "No test files found". Run `vp test` from inside the package directory instead (`cd <pkg> && vp test`) — its own `vite.config.ts` is picked up and `include` resolves correctly.
**Suggested destination**: Testing Reference (Test Runners table)

### Generated single-line JSON data files must be added to the root `fmt.ignorePatterns`

**Discovered during**: claude/medication-interaction-checking-mxcbbl (DDInter compact catalog)
**Learning**: The root `vp check` formats every JSON file, so a large generated data file (a compact array-of-arrays catalog) would be pretty-printed into hundreds of thousands of lines on the next `vp fmt` / pre-commit. Add its path to `fmt.ignorePatterns` in the root `vite.config.ts` next to the OpenAPI snapshot entry, and say so in the slice docs so nobody hand-formats it.
**Suggested destination**: Strategies

## Shared app copy lives in `branding-core`, and the connect menu's heading is an `h2`

The homepage's per-app rows and each SMART app's standalone landing page render
the same `APP_DESCRIPTIONS` entry from `branding-core`, so a copy edit in one
place changes both. `branding-react`'s `AppLanding` takes the app's
`AppSectionId` and the connect menu as children; it owns the page's `h1` (the
app name), which is why `fhir-r4-react`'s `ConnectMenu` heading is an `h2`. A
test that looks for the connect page's heading by level should use level 2.

## A design handoff's "`--radius-5` = 18px" is `--card-border-radius`, not tundra's ramp

Design handoffs read token values out of a DOM snapshot, where the app's
`colors-custom.css` has already re-pinned some tundra ramps. Tundra's own
`--radius-5` is 48px; the 18px card radius the snapshot reports is
`--card-border-radius`. Before binding a handoff's quoted token, grep
`global/react-tundraish/src/colors-custom.css` for the semantic alias and use
that — the ramp step alone can be a different number.

## Nested `<ul>`s make `getAllByRole('listitem')` return the parents too

In a collapsible tree (group `<li>` containing a `<ul>` of row `<li>`s), a
row query by `listitem` role also matches every ancestor `<li>`, and a
`querySelector('a')` filter still matches the parent because it _contains_ the
row's link. Filter on a direct child (`item.querySelector(':scope > a')`) or on
the row's own class to select leaves only.

## A React Query fetch-to-completion effect must depend on the page count

A "load all pages" driver effect keyed on `[active, hasNextPage,
isFetchingNextPage, …]` stalls after one page whenever a page resolves within
a single commit (mocked fetches in tests; a fast server in prod): no committed
render ever observes `isFetchingNextPage === true`, so the dep array is
identical before and after the page lands and the effect never re-fires. Add
`data.pages.length` to the dependencies — it is the one input guaranteed to
change once per page. See the driver in `apps/medications-app/src/app.tsx`.

## A `freeText` pseudonym breaks any consumer that parses the value with a regex

The anonymizer's `freeText` fallback rewrites every letter and digit, so a
value with a literal keyword inside it (`/Date(1779297900000-0400)/`) comes
out as `/Uwbx(7233634345725-5592)/` and a downstream `collectionMillis`-style
regex silently stops matching — the real payload decodes, only the anonymized
fixture is broken. When a source's parser matches a token by pattern, give
that token its own leaf shape in `har-importer-core`'s `shapes.ts` that keeps
the literal and fakes only the data part.

## Windows Tauri release links need `advapi32.lib` because of `rathole`'s build script

**Discovered during**: claude/deploy-actions-failures-s75kxq (v0.2.0 Publish run)
**Learning**: `rathole` 0.5's build script depends on `vergen` 7 → `git2` → `libgit2-sys` 0.14, whose build.rs links winhttp/rpcrt4/ole32/crypt32 but not advapi32; the pinned toolchain's std no longer pulls advapi32 in implicitly, so the build-script link dies with `LNK2019: unresolved external symbol __imp_OpenProcessToken` after ~20 min of compiling. Linux CI never sees it. `tauri-release-publish.yml` passes `-C link-arg=advapi32.lib` in the Windows matrix entry's `rustflags`; if a Windows machine hits the same error locally, set `RUSTFLAGS` the same way. It goes away once rathole drops vergen 7 / git2.
**Suggested destination**: Rust docs

## `tauri-action` picks npm when the lockfile is not inside `projectPath`

**Discovered during**: claude/deploy-actions-failures-s75kxq
**Learning**: tauri-action detects the package manager from a lockfile in `projectPath` (`apps/wildflower-tauri`), not the workspace root, so it ran `npm run tauri build`. Set `tauriScript: vp run tauri` — `vp run <script> <args>` forwards trailing args to the script, so `--target universal-apple-darwin` reaches the Tauri CLI.
**Suggested destination**: Strategies

## A source id has to be a FHIR `id` or adoption's reference rewrite skips it

**Discovered during**: claude/lifelabs-pdf-importer-z45ain
**Learning**: `adoptUnderRecognizedRoot` re-keys a resource whatever its
original `id` is, but the reference rewrite only recognizes
`Type/<id>` where `<id>` matches FHIR's `[A-Za-z0-9\-.]{1,64}` — so a synthesis
that minted ids from `joinIdComponents(...)` (colons, spaces, over 64 chars)
got re-keyed resources whose `DiagnosticReport.result` and
`Observation.subject` still pointed at the _unadopted_ ids. Digest the
components into an id-safe string (`lifelabs-pdf-importer-core`'s `sourceId`,
sixteen hex digits of `fnv1a64`) and keep the readable facts on the resource as
identifiers instead. A property that adopts and then checks every reference
resolves inside the same output catches this in one run.
**Suggested destination**: Source Identity Explanation

## Positioned-text lines: anchor on the first run, tolerate ~5.5pt, and test against the real y's

**Discovered during**: claude/lifelabs-pdf-importer-z45ain
**Learning**: A LifeLabs PDF prints a 9.08pt label and its 9.94pt value up to
4.1pt apart, and a flag+result pair up to 3pt below the test name it belongs
to, while consecutive grid rows are ≥ 9pt apart — a 4pt tolerance split the
`Patient's Phone:` label from its value and a 3pt row-rounding split flagged
rows from their names. Cluster by the _first_ run's y (a running mean lets a
stack of near rows drift into one line) with a 5.5pt tolerance. When writing
the fixture layout that a round-trip property parses back, copy the real
document's y offsets (`Address:` at 64, its lines every ~9pt, `HC #:` at 72):
a plausible-looking layout with the address 2pt lower merged the health-card
value into the address line and the property failed on the layout, not the
parser.
**Suggested destination**: Strategies
