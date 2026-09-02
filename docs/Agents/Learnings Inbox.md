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
