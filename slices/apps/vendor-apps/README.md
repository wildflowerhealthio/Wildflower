# vendor-apps

Vendored third-party FHIR apps inlined as static assets and served via HttpApi.
Today the slice ships a single app: [`patient-browser`][upstream].

[upstream]: https://github.com/smart-on-fhir/patient-browser

## What this package does

`patient-browser` is a SMART-on-FHIR sample app. Rather than shipping it as a
separate static-file server, we build its `dist/` once, base64-encode every
asset into a generated TypeScript module (`src/generated-patient-browser.ts`),
and serve it from our own `HttpApi` group mounted at:

```ts
MOUNT = '/installed-apps/patient-browser'
```

(see `scripts/generate-patient-browser.mjs`). The mount path is rebased into
the HTML at generation time, so the inlined assets reference our route, not
the upstream defaults.

## Host (Tauri) serving — `vendor-apps-rust`

The Tauri host serves the same app from Rust instead of the combined TS module.
The sibling crate [`vendor-apps-rust`](../vendor-apps-rust) serves files from a
**runtime directory** rather than embedding them in the binary:
`setup_vendor_apps(root)` returns an axum router that, for each
`GET /installed-apps/{*path}`, reads the matching file from `root` at request
time. The Tauri host points `root` at `installed-apps/` under its app-data
directory, so updating an app — or dropping a new one in — needs **no recompile**
(the files are read live; a missing file just 404s). Path traversal (`..`,
absolute paths) is rejected before any filesystem access.

Two patient-browser-specific touches are applied at serve time:

- its HTML's root-absolute `/assets/`, `/img/`, `/config/` URLs are rebased onto
  the `/installed-apps/patient-browser` mount, and
- `config/default.json5` is served from the handwritten, committed
  `vendor-apps-rust/patient-browser-config/default.json5` (embedded via
  `include_str!`), overriding any copy on disk — so the on-device FHIR URL
  (`/fhir-r4`) and timeout live in a readable, version-controlled file rather
  than a brittle rewrite of the upstream build.

To populate it, copy a patient-browser build into
`<app-data>/installed-apps/patient-browser/` so that `index.html`, `assets/`,
`img/`, etc. sit directly under it (the regeneration steps below produce the same
`dist/`). The committed config is always served regardless; the rest of the
routes 404 until the directory holds the build.

## Regenerating the assets

The vendored `dist/` lives at `vendor/patient-browser/dist/` and is
**gitignored**, so neither a fresh clone nor CI has it. After pulling this
slice (or whenever you bump the upstream), regenerate the bundle:

1. Clone the upstream `patient-browser` repo somewhere outside this monorepo.
2. Build its production bundle (follow the upstream README; typically
   `npm install && npm run build`, which produces a `build/` or `dist/`
   directory).
3. Copy the build output into `slices/apps/vendor-apps/vendor/patient-browser/dist/`
   so that `index.html`, `assets/`, `img/`, and `config/r4.json5` all sit
   directly under that path.
4. From this package directory, run:

   ```bash
   node scripts/generate-patient-browser.mjs
   ```

   This rewrites `src/generated-patient-browser.ts` with the new asset table.

> **Required after this PR.** The mount point was renamed from
> `/apps/patient-browser` to `/installed-apps/patient-browser`. The committed
> `generated-patient-browser.ts` still has the old path baked into rebased
> HTML, so it must be regenerated against a freshly populated `vendor/` once
> this lands.

## TODO: pin the upstream

The upstream commit/tag is **not pinned yet**. We currently rely on whoever
regenerates the bundle to grab a working `patient-browser` build, and there is
no machinery in this repo that records which revision produced the committed
`generated-patient-browser.ts`. Before this can be reproduced by CI we need
to either:

- vendor the upstream as a git submodule pinned to a known commit, or
- record the upstream commit hash in this README (and ideally in the
  generated file's header banner) every time we regenerate.
