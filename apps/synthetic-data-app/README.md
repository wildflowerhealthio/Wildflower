# synthetic-data-app

The first-party Synthetic Data Loader SMART-on-FHIR app: it reads a published
synthetic data set — by default the GitHub Pages site of
[`wildflowerhealthio/synthetic-data`](https://github.com/wildflowerhealthio/synthetic-data)
— lists its people, and writes the ones picked into the FHIR server the app is
connected to, with their records as the importers wrote them. Two HTML
entries, `launch.html` (the EHR launch endpoint that starts the OAuth2
authorize redirect) and `index.html` (the app root — the redirect target that
completes the handshake and renders the app when a callback is in the URL, and
the standalone connect menu, where the user picks a FHIR server, on a bare
visit).

The load flow — the data set URL form, the people, reading and writing, the
results — is
[`synthetic-data-react`](../../slices/synthetic-data/synthetic-data-react/AGENTS.md)'s
`SyntheticDataScreen`; the data set's layout and manifest are
[`synthetic-data-core`](../../slices/synthetic-data/synthetic-data-core/AGENTS.md)'s.
This package is the SMART shell around it.

## Boot structure

Both entries run on `smart-app-react`, the chrome every self-hosted SMART app
boots through (see [slices/smart-app/AGENTS.md](../../slices/smart-app/AGENTS.md)),
exactly as `apps/health-viewer` does.

`src/main.tsx` is the `index.html` entry: it imports the design-system
stylesheet module (`react-tundraish/styles`), completes a GitHub Pages 404
redirect, keeps the page's `?dataSet=` for after the SMART redirect, wires the
OS colour-scheme listener, and renders `<AppRoot />` inside `<StrictMode>`.

`src/app-root.tsx` exports `AppRoot`: `<SmartAppRoot app="syntheticData"
standalone={standaloneSmartConfig}>` around `<App />` — the slim `BrandBar`
above `<App />` when launched, the full Wildflower chrome with
`APP_DESCRIPTIONS.syntheticData`'s `AppLanding` beside `ConnectMenu` on a bare
visit.

`src/launch-main.tsx` is the `launch.html` entry: the same stylesheet import,
then one `runSmartLaunchEntry({ launch: smartConfig, loadingMessage })` call.

## The page

`src/app.tsx`'s `App` completes the SMART handshake and builds a router
context from it with `buildSmartRouterContext` over `FetchHttpClient.layer`,
plus the handshake's `serverUrl`. `SyntheticDataApp` mounts a one-route router
on a memory history (the real URL still carries the OAuth callback), as
`apps/importer-web` does, so `synthetic-data-react` finds `runAuthed` in route
context. The route renders the title and `SyntheticDataScreen` with the data
set URL this tab keeps (`src/data-set-url-memory.ts`): the page's `?dataSet=`
from a bare visit, else the last URL submitted, else the published set.

## Loading a local data set

Any `http:` or `https:` folder holding an `index.json` can be read: type it in
the Data set URL field, or open the app as
`…/synthetic-data-app/?dataSet=http://localhost:8000/`. The host must allow
cross-origin reads (GitHub Pages does); for a local copy of the data repo's
output, serve it with CORS on, for example `npx serve --cors -l 8000 out`.

## Where the bundle is served

`vp build` writes this package's default `dist/`, and that build is served in
one place: **the published site**, at
[`/synthetic-data-app`](https://wildflowerhealth.io/synthetic-data-app/).
`github-pages` copies `dist/` into the Pages artifact
([../github-pages/README.md](../github-pages/README.md)), and each pull request's
`pr-preview.yml` build publishes the same tree under
`https://wildflowerhealthio.github.io/staging/pr-<n>/synthetic-data-app/`.
Nothing ships on device.

## Registration

The production `synthetic-data-app` registry row and OAuth client are not
seeded yet (#796). In development the debug-only `synthetic-data-app-dev` row
launches the vite dev server instead (below).

`src/config.ts`'s `clientId` must equal the app id it is launched through — the
host's redirect resolver looks an app up by `client_id` — and its scope string
must equal the seeded client's allowed scopes; `gatekeeper-rust`'s
`seeding.rs` test reads `config.ts` to hold the dev client to it.

## Running locally

```bash
vp run -F synthetic-data-app dev     # strictPort, from slices/apps/dev-app-ports.json
```

**Standalone**: open the printed `http://localhost:<port>/`, pick a server on the
connect menu, and load people into it.

**From a Wildflower host**: debug builds of the host seed a
`synthetic-data-app-dev` **cloud** row on that port plus its own OAuth client
(`apps-rust`'s `seed_dev_apps` / `gatekeeper-rust`'s `seed_dev_app_clients`),
so the homescreen carries a "Synthetic Data (Dev)" tile that launches whatever
is serving that port — the vite dev server when it is up, nothing when it is
down. The port has a single source, `slices/apps/dev-app-ports.json`:
`vite.config.ts` reads it through the shared `devAppServer` helper in the root
`vite.config.base.ts` and `apps-rust` embeds it, so the dev server and the row
cannot drift.

The seed only ever writes rows it owns. If an app you uploaded already holds the
`synthetic-data-app-dev` id, the seed logs a warning and leaves it untouched
rather than adopting it — you get no dev tile until that app is renamed.
