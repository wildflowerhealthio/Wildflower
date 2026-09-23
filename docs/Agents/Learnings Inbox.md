# Learnings Inbox

A running log of non-obvious insights discovered during agent sessions. Triage into `Strategies` or a specific reference doc periodically.

_Last triaged 2026-07-04 — durable lessons were promoted to `Strategies.md`, testing- and Effect-tagged entries moved to `docs/Testing` / `docs/Effect`, and entries about removed code (Expo/React Native, Jest, the interop slice) were dropped. Git history preserves everything removed._

<!-- Append new entries below this line -->

## Importer descriptor is bytes-in, not text-in, and identifies formats through `detect`

`FileImporterDescriptor.decode(fileBytes: Uint8Array, settings)` — HAR reads UTF-8 JSON, LifeLabs PDF reads binary through `positioned-text-web`'s `extractPositionedText` (the same seam the PDF anonymizer uses). The picker gates on each registered descriptor's `detect(bytes, fileName)` before decode ever runs, so a batch can span formats; every downstream step (`resolve`, `ReviewBody`, `persist`) dispatches on the pick's `format` tag. If a `BoundFormat<K>['decode']` union balks at a widened callable, `Match.type<FormatKind>().pipe(Match.when('har', …), Match.when('lifelabs-pdf', …), Match.exhaustive)` narrows to each K inside its branch, no `as` cast needed.

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

## `APPLE_SIGNING_IDENTITY` must match the imported cert's name and be a Developer ID cert

**Discovered during**: claude/macos-builds-failed-o56j1o (v0.2.0 Publish run)
**Learning**: The Tauri bundler resolves `APPLE_SIGNING_IDENTITY` by substring against `security find-identity -v -p codesigning` on a keychain holding only `APPLE_CERTIFICATE`, and only after the ~20 min universal compile. The run failed with `failed codesign application: failed to resolve signing identity` because the secret named `Apple Development: ryanmarks@mac.com (X7NW4R3H9Y)` while the .p12 held `Apple Development: Ryan Marks (Ryan Marks)` — and an "Apple Development" cert would not notarize anyway; a GitHub Release needs a "Developer ID Application" cert. `scripts/checks/apple-signing-preflight.sh` now runs first on the macOS runner and reproduces the bundler's lookup, printing the certificate names the .p12 actually contains; run it locally with the same env vars to vet a new .p12 before storing it as a secret. A CSR and .p12 can be made entirely with `openssl req -newkey` / `openssl pkcs12 -export -legacy -certfile DeveloperIDG2CA.pem` when Keychain Access's certificate assistant misbehaves.
**Suggested destination**: Rust docs (release process)

## pdfjs `getDocument({ data })` detaches the caller's ArrayBuffer

**Discovered during**: claude/pr-637-3-lifelabs-binding (generalized importer preview)
**Learning**: `pdfjs-dist` transfers the `ArrayBuffer` behind `data` to its worker, detaching it in the calling realm. Any code that reuses the same `Uint8Array` afterwards — the importer re-decodes a pick on a settings change and uploads the same bytes as the source archive at confirm — dies with `TypeError: attempting to access detached ArrayBuffer` (surfacing far away, e.g. inside an Effect Schema encode). `positioned-text-web`'s `extractPositionedText` now hands pdfjs a copy (`new Uint8Array(bytes)`); keep that invariant if the seam is ever touched.
**Suggested destination**: file-formats docs / Strategies

## OHIF builds live in `ohif-viewer-dist`, and out-of-tree plugins register via `directory`

**Discovered during**: claude/zealous-planck-nxyki7 (adding the OHIF FHIR viewer to the site)
**Learning**: OHIF/Viewers is its own pnpm 11 workspace with a ~10 min rspack build, so it is never built inside this monorepo: `wildflowerhealthio/ohif-viewer-dist` pins the upstream commits, builds, and publishes a release tarball plus digest that `apps/ohif-viewer/prebuilt.json` pins. OHIF master's `platform/app/.webpack/writePluginImportsFile.js` accepts `{ packageName, directory }` entries in `pluginConfig.json` for extensions and modes outside its workspace, which replaces the yarn-hardcoded `pnpm run cli link-extension` step the FHIR viewer guide describes. OHIF reads `app-config.js` at page load, so runtime config (router basename, data sources, SMART client ID) is overlaid at assembly time here and never needs an upstream rebuild.
**Suggested destination**: apps docs / Strategies

## axum `nest("/prefix", …)` drops the trailing-slash root — it escapes to the outer fallback

**Discovered during**: ruthmarks/importer-tweaks-and-cleanup (POST /fhir-r4/ returned the SPA)
**Learning**: `Router::nest("/fhir-r4", inner)` registers only an exact `/fhir-r4` matcher and a `/fhir-r4/{*rest}` catch-all, and matchit's catch-all does **not** match zero trailing segments. So a request to the bare-prefix-plus-trailing-slash `/fhir-r4/` matches neither and falls through to the _outer_ router's fallback — in `apps/wildflower-tauri` that is `spa::handle_serving_spa_html`, which answers `200 text/html` for any method, so a `POST /fhir-r4/` (a FHIR batch/transaction Bundle, whose endpoint is conventionally the base URL with a trailing slash) silently returned the web-app shell instead of reaching HFS. `/fhir-r4` (no slash) and `/fhir-r4/Anything` both work — only the trailing-slash root is lost, which is why per-resource PUT/GET tests never caught it. Fix: `nest_service("/fhir-r4", inner)` claims the whole subtree (bare root + trailing slash included) for the inner router. Watch for this on any slice mounted at a prefix that is itself a live endpoint. Pinned by `slices/emr/emr-rust/tests/batch_bundle_at_base.rs`.
**Suggested destination**: Rust docs / Strategies

## `dicom-parser` ships no TypeScript types — a local `.d.ts` is required

**Discovered during**: D3 DICOM tag parsing implementation
**Learning**: The `dicom-parser` npm package (v1.8.21) has no `types` field, no `@types/dicom-parser` exists, and its main export is a UMD/CJS bundle at `dist/dicomParser.min.js`. A local `src/dicom-parser.d.ts` ambient module declaration is needed in any package that imports it. The key API surface: `parseDicom(byteArray: Uint8Array)` returns a `DataSet` with `.string(tag)`, `.uint16(tag)`, `.intString(tag)`, and `.elements` (a tag-to-element record for detecting sequence presence). Tags are lowercase hex with an `x` prefix (`'x00100010'` for PatientName).
**Suggested destination**: Learnings / file-formats docs

## An axum `from_fn` middleware can be returned as a layer value — box the future and coerce to a fn pointer

**Discovered during**: claude/amazing-bohr-93p4wc (gatekeeper `layer_router_with_*` → `*_middleware`)
**Learning**: To hand a caller a `Layer` instead of a `Router`-wrapping helper, the return type has to be nameable, and neither half of `from_fn_with_state(state, my_async_fn)` is: an `async fn`'s fn-item type is unutterable and its future is opaque, and `impl Layer<Route>` can't work either because `Router::layer` bounds the associated `Service` type (nested `impl Trait` in an associated-type binding isn't allowed). The way through is to box the future and go via a fn pointer, which _is_ nameable: `type Fut = Pin<Box<dyn Future<Output = Response> + Send>>; type Handler = fn(State<S>, HeaderMap, Request<Body>, Next) -> Fut;` then `pub type MyMiddleware = FromFnLayer<Handler, S, (State<S>, HeaderMap, Request<Body>)>;`. The `T` parameter of `FromFnLayer` is the extractor tuple **including** the trailing `Request`. Build it with a non-capturing closure annotated `let handler: Handler = |…| Box::pin(async move { … });`. The result is `Clone`, so a host gating several routers on the same state builds it once and clones it per router (see `apps/wildflower-tauri/src-tauri/src/lib.rs`). `gatekeeper_auth_middleware` / `require_loopback_peer_middleware` are the worked examples.
**Suggested destination**: Rust docs / Strategies

## A slice route directory mounted under a nested `route()` collides on `IndexRoute`

**Discovered during**: claude/nifty-knuth-8ywi8f (HAR Recorder phase 4)
**Learning**: `@tanstack/virtual-file-routes`' `physical()` builds each generated route-variable name from the path _inside_ the mount, so two slices whose mounted directory contains an `index.tsx` both reduce to `IndexRouteImport` / `IndexRoute` and `apps/wildflower-react`'s `routeTree.gen.ts` fails to parse (`Identifier 'IndexRouteImport' has already been declared`) — `apps-react`'s `_auth/home/index.tsx` already holds that name. Mounting the slice's whole `_auth/` directory as a sibling (`physical('', routesDir('<slice>', '_auth'))`, the collector's arrangement) keeps the section name in the in-mount path, so the pair generates as `Auth<Section>Route` / `Auth<Section>IndexRoute`. The section layout then belongs to the slice (`src/routes/_auth/<section>.tsx`), not the app — the app-owned layout in `_auth/gatekeeper.tsx` exists only because gatekeeper has a same-named `_open` sibling.
**Suggested destination**: `apps/wildflower-react` routing docs / Strategies

## A new Tauri-linked crate must be added to `scripts/checks/rust.sh`'s partition lists

**Discovered during**: claude/nifty-knuth-8ywi8f (HAR Recorder, `har-recorder-tauri-rust`)
**Learning**: `rust.sh` splits the workspace into a non-Tauri partition (`--workspace --exclude …`) and a Tauri partition by crate _name_. A new crate that depends on `tauri` is not excluded automatically, so the GTK-less `pre-commit` step tries to compile it, dies in `gdk-sys`'s build script, and the commit is refused with a wall of pkg-config output. Add the crate to all three lists (`non_tauri` excludes, `tauri`, `tauri_names`) in the same PR that creates it; CI's `clippy-all` / `test-all` compile it regardless. Put anything with testable logic in a tauri-free sibling crate (`har-recorder-rust` next to `har-recorder-tauri-rust`) so its tests run in the container.
**Suggested destination**: Rust docs / Strategies (Environment & toolchain)

## `*.css?raw` imports resolve to an empty string under Vitest

**Discovered during**: claude/issue-575-series-tokens (parsing `colors-custom.css` in a test)
**Learning**: Vite's CSS plugin answers a `./some.css?raw` (and `?inline`) import with `''` in the SSR pipeline Vitest runs test modules through — the import succeeds, the module is a string, and it is empty, so a test that parses the stylesheet finds nothing and quietly asserts over an empty set. `?raw` works normally on non-CSS files (`./index.ts?raw` returns the source). A test that needs a stylesheet's text reads it with `readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'x.css'), 'utf8')` instead — which in a browser-facing package (`react-tundraish`) means adding `@types/node` (catalog) and `"types": ["node"]` to its `tsconfig.json`, since react packages here otherwise carry `"types": []` or none at all.
**Suggested destination**: Testing docs / Strategies

## A correlated union survives registry dispatch through a generic, not a `Match` branch

**Discovered during**: the importer's `importer-core` extraction (registry + batch machinery)
**Learning**: Indexing a registry record by a union key loses the correlation between the entry and its settings: `registry[kind].decode(files, settings[kind])` with `kind: FormatKind` typechecks each side against the _union_ of every format's `decode` and settings, so the call is rejected and the usual escape is one `Match.when` branch per format. Making the helper generic in the key keeps the correlation instead — `const decodeFormat = <K extends FormatKind>(registry, settings, kind: K, files) => registry[kind].decode(files, settings[kind])` — because inside the body `K` is one format, not the union. `importer-core/src/read-batch.ts` is the worked example: adding a format now touches the registry only, with no branch to widen anywhere in the read half. The second half of the same cleanup: a descriptor's `decode` that **never fails** (a malformed file comes back as an `unreadableFiles` row, data rather than an error channel) removed every `catchAll` from the shell, since the only thing left to handle is a tag.
**Suggested destination**: Strategies / Effect patterns

## A computed union key is silently unchecked — a correlated record must name every key literally

**Discovered during**: claude/gallant-lovelace-jpglw9 (removing `readBatch`'s `as unknown as` cast)
**Learning**: The converse of the entry above: a generic `K` recovers correlation when _reading_ a registry record, but nothing recovers it when _building_ one from a `kind` variable. TypeScript widens a computed property whose key is a union to an index signature and drops the key/value correlation entirely, so `{ ...batch, [kind]: result }` with `kind: FormatKind` typechecks against **nothing** — it compiles with `result` set to a string literal like `'nonsense'`. It is not an error either, so it reads as safe: `{ [kind]: r }` assigned to `Pick<Rec, K>` _does_ error (`'{ [x: string]: Res<K>; }' is not assignable`), which means the unsoundness only bites in the spread form, exactly the form a fold over `formatKinds` uses. So the `formatKinds`-iteration-plus-`Object.fromEntries` shape cannot be made safe by removing its cast — the cast was the honest part. Building the record as an `Effect.all` **struct** (`{ har: decodeGroup('har'), 'lifelabs-pdf': …, dicom: … }`) checks every slot against its own `Result<K>` and makes a forgotten format a compile error, which the `formatKinds` walk never did. For a one-slot replacement, a `Record<FormatKind, (…) => Batch>` of per-format updaters keeps the public helper non-generic — needed because a type parameter used once in a signature trips oxlint's `typescript(no-unnecessary-type-parameters)`, which is right that the correlation is an implementation detail. Two live instances of the unchecked form remain: `importer-react/src/preview/use-import-run.ts`' `{ ...current.current.settings, [format]: next }` (a `FormatSettings` merge, so the value type is the same union either way) and `preview-panel.test.tsx`' `makeBatch` helper.
**Suggested destination**: Strategies / Effect patterns (next to the correlated-union entry)

## Merging per-file decodes into one review needs the merger to namespace the keys

**Discovered during**: PR #676 review (the importer's unit-per-file → unit-per-format change)
**Learning**: When a per-item decode is keyed within itself and something above merges several items' output into one keyed collection, the _merger_ must namespace the keys — the decode cannot, because it is not given the batch. The importer's per-file `decodeOne` keys resources within one file (DICOM's fixed `patient` / `service-request` / `imaging-study`, HAR's `har-entry-<index>` counting from zero per archive), which was correct when a review unit was a file. Collapsing the unit to a _format_ made the batch decode merge every claimed file's sections into one review while the selection, the server-diff verdicts and the write plan stayed keyed by `(format, key)` — so two DICOM images collided on all three keys and unticking one file's row silently dropped the other's resource. Nothing failed and nothing type-erred: a duplicate key in a `Set` of exclusions is just a smaller set. The fix belongs in the one place that can see the batch (`buildPerFileDecode` prefixes each file's keys with its slot), and the same reasoning applies to the ids: a slot must lead with the file's _index_, not its name, because picking two files with the same name out of two folders is ordinary and a name-only id collides on what a React key and a result id rely on. Worth a property test that the merged keys are distinct — it is the invariant the whole selection model rests on, and a per-file test cannot see it.
**Suggested destination**: Strategies / review lessons

## markdownlint's emphasis style is "first seen wins" per file

`MD049/emphasis-style` runs in `consistent` mode, so the first emphasis marker in
a file sets the rule for the rest of it. Inserting a `*word*` near the top of a
doc that otherwise uses `_word_` flags every _later_ underscore, hundreds of
lines below the edit — the reported lines are not where the problem is. Match
the file's existing marker (the gatekeeper docs use underscores).

## The gatekeeper OpenAPI snapshot covers `/oauth/*` only, not `/access/*`

`documented_router()` in `gatekeeper-rust` deliberately leaves the Owner-facing
`/access` surface out of the committed `openapi/gatekeeper-oauth.openapi.json`,
so a change to a consent body (e.g. the `registration` verdict, the approve
body's `acknowledgedRegistration`) never shows up in the snapshot and
`UPDATE_OPENAPI=1` regenerates only the `/oauth` prose. The TS mirror in
`gatekeeper-core/src/http-api-definition/*.ts` plus a wire round-trip test is
the only drift guard for those shapes today.

## `upsert_client` cannot disable a client

`db/clients.rs::upsert_client`'s `ON CONFLICT DO UPDATE` omits `disabled_at`
(by design — a re-seed must not resurrect an admin disable), which also means
nothing in the crate can _set_ it: a test for "disabled clients are rejected"
has to insert the row already disabled. An admin disable surface needs its own
store method.

## Tauri owns iOS signing: it reads `IOS_MOBILE_PROVISION`, and rewrites `gen/apple` every build

**Discovered during**: claude/mac-notarization-error-hgxawr (iOS TestFlight job)
**Learning**: `tauri ios build` failed on CI with `No Accounts: Add a new account in Accounts settings` and `No profiles for '<bundle id>' were found ... matching iOS App Development provisioning profiles`. Neither names the cause: Tauri signs iOS only when `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD` and `IOS_MOBILE_PROVISION` are all set, and our job set none on the build step — it imported the certificate into a keychain Tauri ignores and passed the profile under `IOS_PROVISIONING_PROFILE`, a name Tauri never reads. Two corollaries worth knowing before debugging this again: importing certificates into your own keychain accomplishes nothing, and committing signing settings under `src-tauri/gen/apple` accomplishes nothing because the project is regenerated every build. Written up in [Apple Release Signing Explanation](../Rust/Apple%20Release%20Signing%20Explanation.md).
**Suggested destination**: already written up; drop on next triage

## `notarytool history` has no `--page-size`, and the preflight blamed the secrets for saying so

**Discovered during**: claude/mac-notarization-error-hgxawr
**Learning**: The macOS preflight validated credentials with `notarytool history … --page-size 0`. No such option exists, so notarytool exited on a usage error without contacting Apple, and the check reported `Notarization credentials are invalid … Generate a new app-specific password` — for credentials it never tested. The generalizable part: a validation step must classify _why_ a tool failed before naming a cause, and notarytool answers a bad flag by printing its usage, which includes `[--password <password>]` — so a classifier that looks for credential keywords first reads every usage error as an auth failure. Written up in [Apple Release Signing Explanation](../Rust/Apple%20Release%20Signing%20Explanation.md).
**Suggested destination**: already written up; drop on next triage

## Tauri's mobile `app_data_dir()` is invisible on both phones, and `Info.ios.plist` is the seam for plist keys

**Discovered during**: claude/app-data-directory-visibility-9z52ac (iOS data directory in the Files app)
**Learning**: `app.path().app_data_dir()` resolves through two entirely different code paths on the two mobile targets, and neither lands anywhere the user can see. iOS goes through `tauri/src/path/desktop.rs` → the `dirs` crate's `mac.rs`, giving `<container>/Library/Application Support/<identifier>`; Android goes through `tauri/src/path/android.rs` → the Kotlin `PathPlugin`, where `getDataDir` is `activity.dataDir`. The reachable ones are `document_dir()`: on iOS `<container>/Documents`, the only part of the container the Files app ever shows — and only if the bundle also sets `UIFileSharingEnabled`, without which the change looks like it did nothing; on Android `getExternalFilesDir(DIRECTORY_DOCUMENTS)`, which Android 11+ hides from the stock Files app anyway because it sits under `Android/data`. Second half, and a correction to the shorthand in the entry above: `tauri ios build` does **not** regenerate `gen/apple` wholesale — `ensure_init` only errors or renames, the identifier and product name are patched into the existing pbxproj, and the Info.plist is _merged_ (`merge_plist` in tauri-cli, last writer wins) from the generated plist, then `src-tauri/Info.plist`, then `src-tauri/Info.ios.plist`. So a plist key belongs in `Info.ios.plist`, where it survives a regenerated Xcode project; the generated plist is still what an Xcode-opened build reads, and the release-prepare workflow `sed`s only its two version keys. Written up in [Data Directory Explanation](../../apps/wildflower-tauri/Data%20Directory%20Explanation.md).
**Suggested destination**: already written up; drop on next triage

## `@cornerstonejs/core` needs an `events` shim aliased in, and both of its init functions

**Discovered during**: claude/github-issue-664-4vf2gg (DICOM archive preview showed "No renderable image")
**Learning**: Two independent faults, the second hidden behind the first. (1) Importing `@cornerstonejs/core` **at all** fails in a Vite browser build: `core`'s index reaches `cache/classes/Mesh.js` → vtk.js `IO/XML/XMLPolyDataReader` → `XMLReader` → `xmlbuilder2`, which is CJS and does `class XMLBuilderCBImpl extends events_1.EventEmitter` at module scope. Vite externalizes Node's `events` to a stub that `console.warn`s and returns `undefined` for every property, so the class heritage throws (`class heritage events_1.EventEmitter is not an object or null`) while core is still evaluating. Nothing in cornerstone's install docs mentions it. The fix is `resolve: { ...base.resolve, alias: { events: createRequire(import.meta.url).resolve('events/') } }` — resolved to a **file path**, because a bare `{ events: 'events' }` just re-matches the builtin. It is not dev-only: `vp build` externalizes browser-platform builtins the same way, so the shipped bundle fails identically. Verify by grepping the served dep chunk (`curl "$ORIGIN/@id/@cornerstonejs/core"` → follow its one `from "/node_modules/.vite/deps/…"`) for `has been externalized`; a stale dev server keeps the old `?v=` hash, so check on a fresh one. (2) `coreInit()` alone is not enough — `@cornerstonejs/dicom-image-loader`'s own `init()` is what calls `registerLoaders`, registering the `wadouri:` scheme and the decode worker, so without it `setStack` gets an image id no loader claims. The basic-stack tutorial calls both; it is easy to copy only the core one.
**Suggested destination**: Strategies / frontend build notes

## Cornerstone's WASM codecs and decode worker break under Vite's dep pre-bundling

**Discovered during**: claude/github-issue-664-4vf2gg (some DICOM files previewed, others showed nothing)
**Learning**: Written up in the [Cornerstone Rendering Explanation](../../slices/file-formats/docs/Cornerstone%20Rendering%20Explanation.md), which this entry exists to flag rather than restate. The transferable shape: when a library locates a worker or a WASM binary with `new URL(..., import.meta.url)`, Vite's dep pre-bundler moves `import.meta.url` and rewrites the URL to a path that does not exist, so the package has to leave `optimizeDeps` — and then every CommonJS dependency reached _through_ it has to be named back in, or it reaches the browser as raw CJS with no `default` export. Grepping the cached chunk in `node_modules/.vite/deps/` shows the rewritten URL directly.

The reason it cost a day is worth keeping separately: the failure did not look like a build failure. Cornerstone decodes exactly one transfer syntax on the main thread with `new Image()`, so that one family of files kept rendering while everything else failed, which reads as missing codec support. Generalize to: before concluding a library lacks support for an input, check whether the inputs that work share a code path the broken ones skip.
**Suggested destination**: Strategies / frontend build notes

## Cornerstone stretches its image unless something re-reads the element's box

**Discovered during**: claude/github-issue-664-4vf2gg (DICOM preview distorted the image)
**Learning**: Written up in the [Cornerstone Rendering Explanation](../../slices/file-formats/docs/Cornerstone%20Rendering%20Explanation.md). The transferable shape: a canvas sized in device pixels _once_ but laid out with `width: 100%; height: 100%` is rescaled into its CSS box on every paint, so the two silently diverge and the image is stretched from then on — a `ResizeObserver` driving the library's own resize call is the fix, and it repairs the initial frame too because an observer delivers one callback when it starts observing.
**Suggested destination**: Strategies / frontend build notes

## A `Context.Tag` bound by a factory is cheaper than the wrappers it grows

**Discovered during**: claude/cool-lovelace-5qnjcc (PR #712 review of the importer slice)
**Learning**: `importer-fundamentals` parameterised its source-file codec by a `Context.Tag` that only one factory (`FileImporter.make`) ever provided. The tag itself was fine; what grew around it was not: a twin type for the decode (`WithContext` vs `Type`), a "binder" factory whose other job was copying fields, six functions wrapping one `transformOrFail`, and a per-binding test file whose only purpose was providing the tag. When a tag has exactly one provider and one consumer, ask whether the consumer can provide it itself (here: the decode constructor) and whether the surface around it can be the schema's own `Schema.decode` / `Schema.encode` rather than named wrappers. The review that prompted this said the slice was "inventing concepts that already exist"; most of the invented ones were scaffolding for the tag.
**Suggested destination**: Strategies

## `Schema.typeSchema(X)`'s encode is not the identity on a struct with null-able optionals

**Discovered during**: claude/cool-lovelace-5qnjcc (the importer's source-file codec became a schema)
**Learning**: A `transformOrFail` whose `from` is `Schema.typeSchema(SomeStruct)` re-encodes the value on the way out, and for a field built with `fhir-r4`'s `OrNullAsOptional` that turns a `null` back into an absent key — so `Schema.encode(codec)(value)` yielded a `DocumentReference` whose `subject` was `undefined` where the declared type says `Reference | null`, and an assertion of `toBeNull()` failed with "expected undefined to be null". The fix is `Schema.declare((u): u is T => Schema.is(Schema.typeSchema(SomeStruct))(u))` as the `from`: a declaration's encode really is the identity, so what the transform builds is what it yields. Reach for this whenever a schema's decoded type is the seam and the round trip has to be lossless.
**Suggested destination**: Effect Patterns Reference (Schema)

## A provenance tag on a pick is usually one branch too many

**Discovered during**: claude/cool-lovelace-5qnjcc (second review pass on the importer slice)
**Learning**: The importer carried `PickedFile.Source` — `local` or `server`, the latter holding the `DocumentReference` reference a re-picked file was fetched from — so every step below the picker had two arms: mint a source file or don't, stamp a fresh reference or the carried one. The tag existed only to avoid writing the same source file twice, and it was not needed for that: the source file's id is already a hash of the bytes, the name and the coding system, so re-picking a stored file mints exactly the source file it came from. Archiving unconditionally collapsed the branch, and the server-diff step the shell already runs classifies the re-minted row `unchanged`, which the initial selection pre-excludes — the "don't upload it twice" behaviour, arrived at by the mechanism that was there anyway. Generalize to: when a value carries a tag whose only job is to skip an idempotent operation, check whether the operation is idempotent enough to just run.
**Suggested destination**: Strategies

## Read a Dependabot bump's upstream diff even when the semver says patch

**Discovered during**: claude/dependabot-prs-consolidation-doqq0h (combining the 2026-09-22 Dependabot PRs)
**Learning**: Two of that week's bumps were broken in ways the version numbers didn't show. `helios-auth` 0.2.1 → 0.2.3, a patch, removed the `JtiCache` trait that `emr-rust` used to enforce per-`jti` revocation. Dependabot also bumped only two of the four exact-pinned helios crates, so the group would have landed on mixed versions. The fix was to move all four pins in lockstep and re-home the check in an `AuthProvider` wrapper that reads `Principal::jti`. `fhirclient` 3.0.0 ships typings that import a `./types` module missing from the tarball, so every option and state type resolves to `any` without a compile error. It also made the bare `fhirclient` entry types-only (the runtime is `fhirclient/browser`). A green Dependabot lockfile is not evidence either way: regenerate it with `vp install` / `cargo update -p`, then build and probe the types before merging.
**Suggested destination**: Dependencies docs

## Gate the privileged write with a proof type, not the handler with a check

**Discovered during**: claude/gatekeeper-auth-structure-dx2mrd (the gatekeeper authority refactor, #730)
**Learning**: The `/oauth/authorize` fast path issued an authorization code with no human in the loop, and nothing in the types said so — the authority was a `bool` in a local struct three functions away from the store write, and the same write (`issue_authorization_code`) was reachable from two flows with different checks. Scope-gated capabilities ("may this caller reach this table?") did not help, because the browser arriving at `/authorize` holds no token. What made it auditable was gating the _write_: each privileged store method lives in one writer whose method takes a proof type with private fields and a single constructor, the function that checks the rule (`DelegatedScopes::clamp`, `GrantCoverage::resolve`, `RedeemedAuthorizationCode::redeem`, …). The audit becomes the constructors plus the writers, and a proof that has no human behind it (`HostOwnerEntitlement`, the standing-grant fast path) is a _named type_ a reviewer greps for. Two textual source guards back-stop the language: privileged method names pinned to writer files, the unproven constructor pinned to seeding. Keep proofs only where a shared writer or a second flow consumes them — one constructor and one consumer in the same file is ceremony (the earlier `OwnerApproval` was dropped for that reason). Order the flow so the proof is obtained _before_ the mint but the mutation (rotation) after, or a signing failure burns the presented credential.
**Suggested destination**: Strategies (auth & bootstrap design); the Scope-Gated Endpoints How-To already carries the mechanics

## Name types for what they are, not for the moment they were produced

**Discovered during**: claude/gatekeeper-pr-stack-refinement-r3e9yy (the review pass over the gatekeeper authority chain)
**Learning**: The maintainer's review of the authority refactor was mostly about names, and the rejected names had one shape in common. Event-style result types (`DeviceAuthorizationStarted`, `AuthorizationStart`, `ExchangedToken`), verb-ish parameter bags (`CodeApproval`, `MintRequest`), half-objects standing in for a decision (`RegistrationWrite::{Untouched, Widen}`), and roles described in the abstract (`ScopeCeiling`, `RegistrationContext`, `MintAuthority`) all made the reader reconstruct what the value _is_. What landed instead: a noun for the thing held (`DeviceCodes`, `IssuedTokens`, `IssuedAuthorizationCode`, `ApprovableScopes`, `TokenEntitlement`), `Option<T>` in place of a two-variant enum whose only other variant means "don't", and a type's own question-methods (`client.allows_grant_type(…)`) rather than a pass-through accessor (`client.client().allowed_grant_types`). Two smaller rules: a local holding scopes says `_scopes`, and a bool that encodes a policy is named for the policy (`registration_is_locked`), not for the identity it is derived from (`is_first_party`). Delete a parameter bag outright when an existing domain type already carries its fields (`approve_for_code` takes the `PendingCodeRequest` the flow already has).
**Suggested destination**: Review Standards Reference §8 (Naming)

## A closed set of authorities is an enum, not a trait

**Discovered during**: claude/gatekeeper-pr-stack-refinement-r3e9yy (review of #730)
**Learning**: The gatekeeper authority chain first modelled "the proofs a writer accepts" as traits (`TokenEntitlement`, sealed, and its sub-trait `GrantRedemption`), and the review asked whether `CodeAuthority` should become one too. It went the other way: all three are enums. A sealed trait needs a `mod sealed` plus an `impl Sealed` per type to stay closed, and even then the set is wherever the impls are, while an enum states the whole list in one block, which is what an audit reads. It also gives derived facts for free (`is_host_owner` is `matches!(self, HostOwner(_))`, not a flag every implementor must set correctly). The cost is that a test can no longer stub a proof with a fake impl; build the real proof through its real constructor instead (the `redeemed_code` fixture), which tests more. Rule of thumb: when a doc says "only these types may …", use an enum; when it says "anything that can …" (ports, `FromState`, extractor capabilities), use a trait.
**Suggested destination**: Review Standards Reference §8 (Naming), or a new "Types" section

## Gatekeeper's in-memory test database fails overlapping writes instead of waiting

**Discovered during**: claude/tender-ride-6y7s0b (the loopback owner dialog, #697)
**Learning**: `persistence_rust::open_in_memory_pool` opens a `mode=memory&cache=shared` SQLite database. Shared-cache mode uses table-level locks and reports a conflict as `SQLITE_LOCKED` ("database table is locked") right away, so `busy_timeout` never applies. A test fails when two connections touch the same table at once. The existing gatekeeper integration tests never hit this because they are single-threaded `#[tokio::test]`s: the store calls are synchronous, so the startup tasks `setup_gatekeeper` spawns (retention sweep, reapers) only run between the test's own awaits. Two things break that. One is `flavor = "multi_thread"`: the startup sweep then raced the test's first `upsert_client`. The other is work on `spawn_blocking`, such as the loopback dialog's decision, which runs on another thread while the test keeps querying. In the second case the _background_ write is the one that fails, and it fails silently (it is only logged), so the test times out instead of failing where the bug is. Single-threaded tests are not enough once a test has background writes: under nextest each test is a fresh process, so the startup tasks run during the test's first awaits and overlapped the loopback dialog's decision about one run in twenty. Run such tests on a temporary file-backed database (`spin_up_with_loopback_prompt` does), where overlapping access waits on `busy_timeout` as it does in the app. Wait for the background work on an in-memory signal (the pending-consent `watch` channel) rather than by polling.
**Suggested destination**: Testing Reference (Rust integration tests) or the Diesel Persistence How-To

## The Tauri host's unmatched routes now 404; its browser-facing pages live on the hosted owner UI

**Discovered during**: claude/upbeat-darwin-yl1cre (removing the host's embedded single-file owner UI)
**Learning**: The host's API router used to answer any unmatched path with `200` and the embedded owner-UI shell, so an unimplemented API route surfaced as a client-side `ParseError` (see the SPA-fallback note in the Effect Patterns Reference) and a bare-prefix route like `POST /fhir-r4/` silently got HTML. It now answers `404` (`apps/wildflower-tauri/src-tauri/src/not_found.rs`): JSON `{ "error": "RouteNotFound", "path", "openInApp" }` for API clients, a small HTML page with the same link for browsers. Every URL the gatekeeper hands a browser (the device `verification_uri`, the `/authorize` polling page) now points at the hosted `main-web` build with `?server=<served origin>`, via `shared_structures_rust::owner_ui::OwnerUiBase` and the `owner_ui_base_url` / `owner_ui_dev_base_url` keys in `tauri-shared-config.json`. A debug host links to the `main-web` dev server on 5195, not to the Tauri dev server on 1420: that one serves `main-tauri`, which needs Tauri IPC and hangs in an ordinary browser.
**Suggested destination**: Origins Explanation

## `bundle.resources` paths must exist at compile time, even in debug builds

**Discovered during**: ruthmarks/first-party-apps-own-dist (#541, narrowing the self-hosted-apps resource mapping)
**Learning**: `tauri-build` resolves and copies every `bundle.resources` entry from the crate's `build.rs` on every compile, including debug builds and `cargo check`, not just when bundling a release. A path that doesn't exist fails with `ResourcePathNotFound`, and a glob that matches nothing fails with `GlobPathNotFound` (`tauri-utils` `resources.rs`). So a resource can only name a directory that a fresh clone and CI have. A gitignored vendored build such as `slices/apps/self-hosted-apps/patient-browser/` can't be named directly. Map a tracked parent directory instead, which is why `tauri.conf.json` still maps all of `self-hosted-apps/`.
**Suggested destination**: slices/apps/self-hosted-apps/README.md already covers the specific case; a general note belongs in a Tauri/Rust reference

## A CSS `@import` of a package stylesheet ships it twice when the package's JS also imports it

**Discovered during**: ruthmarks/fhir-r4-react-app-shell (#572, the shared SMART app shell)
**Learning**: `react-tundraish` and `branding-react` import their own `styles.css` from their JS entries (`src/index.ts`'s first line). An app that also names that stylesheet gets one copy only if it names it the same way, as a side-effect module import, because Vite dedupes a stylesheet by module id. A `.css` file that `@import`s it instead gets the stylesheet inlined into its own module, which the bundler cannot match to the JS-imported copy: the first draft of the SMART apps' shared stylesheet stack was an `@import` file, and it shipped every tundraish and branding token twice (the SMART apps' shared CSS chunk went from ~97 KB to ~128 KB). Nothing warns. The build succeeds and the page looks right, because the duplicates declare the same values. Put a stack of package stylesheets in a TS module of side-effect imports (`react-tundraish/styles`), and count a token's declarations in the built CSS (`grep -o -- '--font-sans:' dist/assets/*.css`) to check.
**Suggested destination**: CSS / styling section of the Vite+ or React Testing docs, or `slices/branding/AGENTS.md` "Consuming the styles"
