# self-hosted-apps

Home for vendored third-party FHIR apps served from the device. Today that's a
single app: [`patient-browser`][upstream], a SMART-on-FHIR sample app.

[upstream]: https://github.com/smart-on-fhir/patient-browser

This directory holds the **vendored builds** — one gitignored folder per app
(e.g. `patient-browser/`), each containing the app's static files — plus these
docs. There is no TypeScript package here anymore: the app is served by
the sibling Rust crate [`self-hosted-apps-rust`](../self-hosted-apps-rust) at the root of
a dedicated loopback origin. (The former TS path — a base64-inlined
`generated-patient-browser.ts` served from an `HttpApi` group at
`/installed-apps/patient-browser` — has been removed.)

## Host (Tauri) serving — `self-hosted-apps-rust`

[`self-hosted-apps-rust`](../self-hosted-apps-rust) serves files from a **runtime
directory** rather than embedding them in the binary:
`setup_installed_app(app_id, app_dir)` returns an axum router that, for each
`GET /{path}`, reads the matching file from `app_dir` at request time. The
Tauri host binds one dedicated loopback `TcpListener` per installed app — each
app gets its own origin (`http://127.0.0.1:<port>/`) read from the
`internal_apps` table in the apps slice — and serves the router at the **root**
of that origin. The host points `app_dir` at `installed-apps/<app-id>/` under
its app-data directory, so updating an app — or dropping a new one in — needs
**no recompile** (the files are read live; a missing file just 404s). Path
traversal (`..`, absolute paths) is rejected before any filesystem access.

Per-origin isolation matters because installed apps are third-party code: a
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

To run it, copy a patient-browser build into
`<app-data>/installed-apps/patient-browser/` so that `index.html`, `assets/`,
`img/`, etc. sit directly under it. The committed template is always served
regardless; the rest of the routes 404 until the directory holds the build.

## Vendoring / updating the assets

Each app's static build lives directly under its own folder here (e.g.
`patient-browser/`) and is **gitignored**, so neither a fresh clone nor CI has
it. After pulling this slice (or whenever you bump the upstream), refresh it:

1. Clone the upstream `patient-browser` repo somewhere outside this monorepo.
2. Build its production bundle (follow the upstream README; typically
   `npm install && npm run build`, which produces a `build/` or `dist/`
   directory).
3. Copy the build output into `slices/apps/self-hosted-apps/patient-browser/`
   so that `index.html`, `assets/`, `img/`, and `config/r4.json5` all sit
   directly under that path.
4. Copy those same files into `<app-data>/installed-apps/patient-browser/` for
   the host to serve (root-absolute URLs are already correct; no rebase).

## Temporary measure — cloud app store coming

This hand-copied, gitignored vendoring is a **stopgap** while we prepare a
cloud "app store" the device pulls app builds from at install time, which will
replace the manual copy above. Until then:

- the build is copied in by hand (steps above), and
- the upstream commit/tag is **not pinned** — nothing in this repo records which
  `patient-browser` revision produced the bundle, so note it by hand when you
  refresh, until the app store makes provenance automatic.

(An earlier attempt vendored the upstream as a git submodule under
`slices/apps/vendor-apps/`; that pulled the upstream's entire working tree and
`node_modules` into the pnpm workspace and was removed in favor of this
static-files-only layout.)
