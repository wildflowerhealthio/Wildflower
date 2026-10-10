# ohif-viewer-web

The [OHIF Viewer](https://ohif.org) with the
[FHIR Viewer mode](https://ohif.org/modes/fhir-viewer) (the
`@ohif/fhir-viewer` extension from `node-on-fhir/ohif-fhir-viewer`), published
at <https://wildflowerhealth.io/ohif-viewer>. It launches from an EHR with
SMART on FHIR URL parameters and reads imaging studies from the FHIR server
that launched it.

This package builds nothing from source. OHIF is a ten-minute webpack build
with its own pnpm workspace, so that build lives in
[`wildflowerhealthio/ohif-viewer-dist`](https://github.com/wildflowerhealthio/ohif-viewer-dist),
which pins the upstream commits, links the extension and its bundled mode,
publishes each build as a GitHub Release (`ohif-viewer.tar.gz` plus its
SHA-256) and serves the same build on its own GitHub Pages site for a
standalone look. This package pins one of those releases and owns everything
Wildflower-specific: the runtime configuration, the site section, the header
nav link.

## Layout

- `prebuilt.json` — the pinned release: `{ "pin": { "url", "sha256" } }`, or
  `{ "pin": null }` while no release is pinned.
- `config/app-config.js` — OHIF's runtime `window.config`. Laid over the
  archive's own copy at build time, so changing it is an ordinary PR here with
  no rebuild upstream.
- `src/prebuilt.ts` — pin validation, digest checking and the stub page (pure,
  unit-tested).
- `src/build.ts` — the `build` script: download, verify, extract, overlay.
- `src/app-config.test.ts` — runs `config/app-config.js` as a browser would and
  checks the basename derivation and the launch wiring.

## Build

```bash
vp run -F @wildflowerhealthio/ohif-viewer-web build   # dist/ = pinned release + config/app-config.js
vp run -F @wildflowerhealthio/ohif-viewer-web dev     # vp preview of dist/
vp test                       # unit tests
```

`build` downloads the pinned archive, refuses it unless its SHA-256 matches the
pin, extracts it into `dist/` (`tar` must be on `PATH`), checks `index.html`
arrived, and writes `config/app-config.js` over the archive's `app-config.js`.
With `"pin": null` it writes a one-page stub saying the viewer is not pinned,
so `vp run pack` and the wildflower-site-web assembly stay green.

## SMART launch

The published viewer is path-agnostic: the prebuilt bundle is built with a
relative `PUBLIC_URL`, and `app-config.js` derives `routerBasename` from its
own script URL. The same build therefore serves `wildflowerhealth.io/ohif-viewer/`
and a PR preview under `…/staging/pr-N/ohif-viewer/`.

The worklist at the basename is the launch entry point. An EHR launches

```text
https://wildflowerhealth.io/ohif-viewer/?iss=<FHIR base URL>&launch=<launch id>
```

The FHIR data source (the default, per `app-config.js`) discovers the server's
SMART configuration, redirects to authorize, and the server redirects back to
`https://wildflowerhealth.io/ohif-viewer/` with the code. Picking a study on the
worklist then navigates client-side into the `fhir-viewer` mode.

GitHub Pages serves a site-wide `404.html` for unknown paths. That page probes
ancestor directories for an `index.html`, finds `/ohif-viewer/index.html`, and
redirects there with `?redirect=/fhir-viewer&…`. The redirect restoration block
in `config/app-config.js` reads that parameter and rewrites the URL with
`history.replaceState` before the OHIF router initialises, so deep links like
`/ohif-viewer/fhir-viewer?iss=…` work on a fresh page load.

The first-party apps do the same through `restoreRedirectedUrl` in
`branding-core` (`spa-redirect.ts`). This viewer cannot: the bundle is
downloaded prebuilt and has no entry module of ours to call it from, so the
block here is a hand-rolled copy of those steps and has to track them.

`?iss=` without `launch` sets the FHIR server without an OAuth redirect, for
standalone testing.

### Client, scopes and the Wildflower server

The Wildflower server seeds what the viewer needs:

- apps migration `0007_seed_ohif_viewer_app` registers the `ohif-viewer`
  app row whose launch URL is the worklist launch above;
- gatekeeper migration `0009_seed_ohif_viewer_client` registers the
  viewer's public PKCE client with `https://wildflowerhealth.io/ohif-viewer/` as its
  redirect URI and the read-only scopes the viewer requests;
  `0010_ohif_viewer_client_fhir_viewer_redirect` repoints that redirect at the
  `/fhir-viewer` route, and `0016_repair_ohif_viewer_client` seeds the client in
  that end state on an install that skipped `0009` (it shares its version with
  another migration). `0029_rekey_ohif_viewer_clients` re-keys it to a
  random id (`941de68e6b59eb9dcc32df8ede89e636`) and the dev client to another,
  and apps migration `0020_rekey_ohif_viewer_clients` points the tiles and their
  launch URLs' `clientId` at them.

`app-config.js` sends that client ID as `smartClientId` and a `smartScope` that
must stay equal, element for element, to that client's `allowed_scopes` (and to
the dev client's in `gatekeeper-rust/src/seeding.rs`). `?client_id=` on the
launch URL or a value saved from the SMART Preferences panel still overrides
the client ID, for launching from another FHIR server.

### Dev row

A debug build of the host also seeds an `ohif-viewer-dev` row and client
(`apps-rust/src/dev_seed.rs`, `gatekeeper-rust/src/seeding.rs`) on the port
`dev-app-ports.json` names. `vp run -F @wildflowerhealthio/ohif-viewer-web dev` previews
`dist/` on that port, and `app-config.js` sends the dev client's ID
(`f9866f7b1d0d8505dc65ef4f749664b5`) when served from a loopback origin.

Like the other first-party apps' dev rows, this one launches
`http://localhost:<port>/fhir-viewer?…`, the production launch template against
the preview origin. The preview server is the sole origin, so the viewer's
cross-origin behaviour in dev matches production. The dev client's
`http://localhost:<port>/fhir-viewer` redirect URI is what matches the launch —
exact-URL, hence the route rather than the root. The tile serves nothing until
the preview is running.

## Updating the viewer

1. Bump the upstream pins in `ohif-viewer-dist` and let its workflow publish a
   release.
2. Copy the release's asset URL and the contents of `ohif-viewer.tar.gz.sha256`
   into `prebuilt.json`.
3. `vp run -F @wildflowerhealthio/ohif-viewer-web build`, then `vp run -F @wildflowerhealthio/wildflower-site-web build` to see it
   assembled; the PR preview shows it live.
