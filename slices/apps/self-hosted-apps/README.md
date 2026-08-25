# self-hosted-apps

Home for vendored FHIR app builds. Four directories live here, and they no
longer all play the same role:

| Directory         | Role                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `patient-browser` | The only remaining **release** self-hosted app: a vendored build of the third-party [`patient-browser`][upstream] sample app, seeded by apps migration `0002` and served from its own loopback origin. |
| `medication`      | Build output of `apps/medications-app`. **Source** for the published `/medications-app` section of the Pages site, and fallback content for the debug-only `medications-app-dev` row.                  |
| `web-trace`       | Build output of `apps/web-trace`. Same arrangement for `/web-trace-app` and `web-trace-app-dev`.                                                                                                       |
| `importer`        | Build output of `apps/importer-web`. Same arrangement for `/importer-app` and `importer-app-dev` — the one shipped app that **writes** to the FHIR base its SMART launch named.                        |

[upstream]: https://github.com/smart-on-fhir/patient-browser

## Which mechanism still serves which directory

The three first-party apps launch in production from the deployed site
(<https://wildflowerhealth.io>), as **cloud** rows — apps migrations
`0005_first_party_apps_to_cloud` (Medications, Web Trace) and
`0006_seed_wildflower_importer_app` (Importer). Their build output stays here
because two other consumers read it:

1. `apps/github-pages` copies these directories into the published artifact (see
   [that package's README](../../../apps/github-pages/README.md)); this is why
   the three apps' vite `outDir`s cannot move.
2. Debug builds seed a `<app>-dev` self-hosted row per app
   (`apps-rust/src/dev_seed.rs`) whose `content_folder` is the directory here, so
   the host can serve _something_ on the dev port when the vite dev server is not
   running.

The vendored-build **mechanism** therefore stays (patient-browser needs it, and
so does the dev fallback), including the `bundle.resources` shipping of this
whole directory in release builds — which is now partly dead weight: in a release
build only `patient-browser/` is referenced by a row's `content_folder`. Removing
the other three from the bundle would save space at the cost of a
`bundle.resources` entry that no longer matches the directory, so they are left
in for now; revisit if bundle size matters.

**Fallback caveat (dev).** The fallback content a `<app>-dev` row serves is a
_production_ build, which sends the production `clientId`
(`import.meta.env.DEV` is false in a built bundle). Since the production client
now registers only the absolute published-site redirect, a SMART handshake
started from that fallback content cannot complete: the tile renders, auth
fails. Run the vite dev server (which sends the `-dev` client id) for a working
dev launch.

This directory holds the **vendored builds** — one gitignored folder per app
(e.g. `patient-browser/`), each containing the app's static files — plus these
docs. There is no TypeScript package here anymore: the apps are served by
the sibling Rust crate [`self-hosted-apps-rust`](../self-hosted-apps-rust) at the root of
a dedicated loopback origin. (The former TS path — a base64-inlined
`generated-patient-browser.ts` served from an `HttpApi` group at
`/installed-apps/patient-browser` — has been removed.)

## Host (Tauri) serving — `self-hosted-apps-rust`

[`self-hosted-apps-rust`](../self-hosted-apps-rust) serves files from a **runtime
directory** rather than embedding them in the binary:
`setup_self_hosted_app(app_id, app_dir)` returns an axum router that, for each
`GET /{path}`, reads the matching file from `app_dir` at request time. The
Tauri host binds one dedicated loopback `TcpListener` per self-hosted app — each
app gets its own origin (`http://127.0.0.1:<port>/`) read from the
`self_hosted_apps` table in the apps slice — and serves the router at the **root**
of that origin. The host points `app_dir` at `self-hosted-apps/<content_folder>/`
under its app-data directory, so updating an app — or dropping a new one in — needs
**no recompile** (the files are read live; a missing file just 404s). Path
traversal (`..`, absolute paths) is rejected before any filesystem access.

Per-origin isolation matters because self-hosted apps are third-party code: a
distinct origin means a distinct security context (its own storage and cookies,
no Same-Origin Policy share with the API). Serving at the root also means the
upstream build's root-absolute `/assets/`, `/img/`, `/config/` URLs are correct
as-is — there is **no HTML rebase**.

The one app-specific touch is the **committed templates tree**. Each file lives
at `self-hosted-apps-rust/templates/<app-id>/<serve-path>.hbs` and is embedded
into the binary at compile time via `include_dir!`; a matching template is
rendered per request with Handlebars and served at `/<serve-path>` on that app's
origin, winning (case-insensitively) over any same-path file on disk. Rendering
is keyed on the request's provenance: a direct loopback caller (the Tauri
webview) gets the loopback API origin (e.g. `http://127.0.0.1:8080`), while a
request forwarded by the trusted front (nginx sets the `Forwarded` header before
the request enters the tunnel) gets `https://<public_host>` from the tunnel's
configured public host. That value is exposed to templates as the single
`{{apiOrigin}}` variable. Today the only template is patient-browser's SMART
config, `templates/patient-browser/config/default.json5.hbs`, whose FHIR `url` is
`{{apiOrigin}}/fhir-r4` — so the on-device FHIR URL lives in a readable,
version-controlled file rather than a brittle rewrite of the upstream build.
Adding a new template file needs no code change, just a Rust rebuild (the tree
is embedded at compile time), and other apps just get whatever's on disk.

Populating that directory is no longer a hand-copy. Two install surfaces feed
it (see below): the **vendored-build sync** places the shipped apps
(patient-browser, plus the two first-party builds used as dev fallback content)
there at host startup, and the **upload endpoint** extracts a
user-supplied `.zip` into a new `self-hosted-apps/<slug>/`. The committed
template is always served regardless; the rest of an app's routes 404 until its
directory holds the build.

## Install surfaces

Two paths populate `<app-data>/self-hosted-apps/` at runtime. Neither needs a
recompile of the serving crate.

### Vendored builds (shipped apps)

Each shipped app's static build lives directly under its own folder here (e.g.
`patient-browser/`) and is **gitignored**, so neither a fresh clone nor CI has
it. To refresh it after pulling this slice (or bumping the upstream):

1. Clone the upstream `patient-browser` repo somewhere outside this monorepo.
2. Build its production bundle (follow the upstream README; typically
   `npm install && npm run build`, which produces a `build/` or `dist/`
   directory).
3. Copy the build output into `slices/apps/self-hosted-apps/patient-browser/`
   so that `index.html`, `assets/`, `img/`, and `config/r4.json5` all sit
   directly under that path.

The host **syncs these into app-data automatically** at startup —
`sync_vendored_self_hosted_apps` (`apps-rust/src/seed.rs`), so there is no
manual copy into `<app-data>/` anymore:

- **dev** (debug builds): overwrite-mirror from the workspace source tree on
  every startup, so a rebuilt vendored app always refreshes on disk;
- **release** builds: the directory is bundled via `tauri.conf.json`
  `bundle.resources` and copied **if-missing** on first run from the app's
  resource dir — never clobbering a user's uploads or manual refresh, at the
  cost of accepted staleness until a future update mechanism.

Both no-op when nothing is vendored (the gitignored builds are absent on a fresh
clone / in CI), and both skip the tracked `README.md` / `.gitignore` that sit
beside the app folders. Root-absolute URLs are already correct; no rebase.

### Uploaded builds (user apps)

A `.zip` bundle can be uploaded at runtime from the apps editor's **"Add
self-hosted app"** section (name + `.zip` picker), which `POST`s the raw
`application/zip` body to the owner-gated `POST /self-hosted-apps?name=…`
endpoint. The host extracts the zip (zip-slip guarded, capped at 512 MiB
uncompressed / 20k entries, macOS Finder litter — `__MACOSX/` / `.DS_Store` /
AppleDouble `._*` — dropped, then a single top folder hoisted so the app serves
at the root), derives a slug from the name (used verbatim — a clash is rejected
`400 InvalidName`, not suffixed) and allocates a loopback port, inserts the
`apps` + `self_hosted_apps` rows in one transaction, atomically renames the
extraction into `<app-data>/self-hosted-apps/<slug>/`, and starts the listener
restartlessly — the tile appears without a restart.

**Launch entry point.** At install the extractor infers a `launch_path`: a
bundle that ships a `launch.html` is a SMART launcher, so the row records
`/launch.html?launch={launch}&iss={origin}/fhir-r4` and a launch routes there
(the path off the app's own origin, `{origin}` → the served FHIR origin,
`{launch}` a fresh nonce); a bundle with only `index.html` records `NULL` and
launches at the bare origin. The owner can edit or clear the path afterwards via
`PUT /apps/{id}` (see `docs/Apps/Explanation.md`) — the "Launch path" field in
the apps editor.

### Delete semantics

Uploaded apps are **removable** — `DELETE /apps/{id}` stops the listener and
deletes the rows and files. Vendored/seeded apps (patient-browser) carry
`self_hosted_apps.seeded = 1` and stay protected: their delete still returns
`409 AppNotEditable`. The client-facing contract is the `removable` flag on
`AppListEntry` (true for cloud rows and non-seeded self-hosted rows); the
editor's Remove button follows it.

## Temporary measure — cloud app store coming

The gitignored vendoring is still a **stopgap** while we prepare a cloud "app
store" the device pulls app builds from at install time. The copy _into_
app-data is now automated (the sync above), but until the app store lands:

- the vendored source build under `slices/apps/self-hosted-apps/<app>/` is still
  produced and copied in by hand (steps above), and
- the upstream commit/tag is **not pinned** — nothing in this repo records which
  `patient-browser` revision produced the bundle, so note it by hand when you
  refresh, until the app store makes provenance automatic.

(An earlier attempt vendored the upstream as a git submodule under
`slices/apps/vendor-apps/`; that pulled the upstream's entire working tree and
`node_modules` into the pnpm workspace and was removed in favor of this
static-files-only layout.)
