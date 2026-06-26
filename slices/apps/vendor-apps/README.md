# vendor-apps

Home for vendored third-party FHIR apps served from the device. Today that's a
single app: [`patient-browser`][upstream], a SMART-on-FHIR sample app.

[upstream]: https://github.com/smart-on-fhir/patient-browser

This directory holds the **vendored build** (under `vendor/`, gitignored) and
these docs. There is no TypeScript package here anymore: the app is served by
the sibling Rust crate [`vendor-apps-rust`](../vendor-apps-rust) at the root of
a dedicated loopback origin. (The former TS path — a base64-inlined
`generated-patient-browser.ts` served from an `HttpApi` group at
`/installed-apps/patient-browser` — has been removed.)

## Host (Tauri) serving — `vendor-apps-rust`

[`vendor-apps-rust`](../vendor-apps-rust) serves files from a **runtime
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

The one patient-browser-specific touch is the **committed config override**:
`/config/default.json5` is served from the handwritten, committed
`vendor-apps-rust/patient-browser-config/default.json5` (embedded via
`include_str!`), overriding any copy on disk — so the on-device FHIR URL
(`/fhir-r4`) and timeout live in a readable, version-controlled file rather than
a brittle rewrite of the upstream build. The override is keyed on the app id;
other apps just get whatever's on disk.

To run it, copy a patient-browser build into
`<app-data>/installed-apps/patient-browser/` so that `index.html`, `assets/`,
`img/`, etc. sit directly under it. The committed config is always served
regardless; the rest of the routes 404 until the directory holds the build.

## Vendoring / updating the assets

The vendored build lives at `vendor/patient-browser/dist/` and is
**gitignored**, so neither a fresh clone nor CI has it. After pulling this slice
(or whenever you bump the upstream), refresh it:

1. Clone the upstream `patient-browser` repo somewhere outside this monorepo.
2. Build its production bundle (follow the upstream README; typically
   `npm install && npm run build`, which produces a `build/` or `dist/`
   directory).
3. Copy the build output into `slices/apps/vendor-apps/vendor/patient-browser/dist/`
   so that `index.html`, `assets/`, `img/`, and `config/r4.json5` all sit
   directly under that path.
4. Copy that same `dist/` into `<app-data>/installed-apps/patient-browser/` for
   the host to serve (root-absolute URLs are already correct; no rebase).

## TODO: pin the upstream

The upstream commit/tag is **not pinned yet**. We currently rely on whoever
refreshes the bundle to grab a working `patient-browser` build, and there is no
machinery in this repo that records which revision produced it. Before this can
be reproduced by CI we need to either:

- vendor the upstream as a git submodule pinned to a known commit, or
- record the upstream commit hash in this README every time we refresh it.
