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
The sibling crate [`vendor-apps-rust`](../vendor-apps-rust) embeds the vendored
`dist/` as **individual files** at build time (its `build.rs` walks the same
`vendor/patient-browser/dist/`), rebasing `/assets/`, `/img/`, `/config/` in the
HTML onto the mount. The SMART config is **not** derived from upstream by string
rewriting; a handwritten `config/default.json5` committed at
`vendor-apps-rust/patient-browser-config/default.json5` is served verbatim (and
overrides any `config/default.json5` in the dist), so the on-device FHIR URL
(`/fhir-r4`) and timeout live in a readable, version-controlled file.
`setup_vendor_apps()` returns an axum router mounted into the host's loopback
API at `/installed-apps/patient-browser/`, which is where the
`GET /apps/patient-browser` launch redirect lands.

Because `build.rs` reads the same gitignored `vendor/` directory, the **same
regeneration step below populates the asset bytes**. The handwritten config is
always embedded regardless (it's committed, not in the dist), so it survives
dist regens and serves even on a checkout without the vendored build; with
`vendor/` absent the rest of the routes 404 until you build the upstream dist.
No separate `generate` run is needed for the Rust side — `cargo build` picks the
dist up directly.

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
