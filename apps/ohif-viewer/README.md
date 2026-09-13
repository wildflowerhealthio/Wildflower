# ohif-viewer

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
vp run -F ohif-viewer build   # dist/ = pinned release + config/app-config.js
vp run -F ohif-viewer dev     # vp preview of dist/
vp test                       # unit tests
```

`build` downloads the pinned archive, refuses it unless its SHA-256 matches the
pin, extracts it into `dist/` (`tar` must be on `PATH`), checks `index.html`
arrived, and writes `config/app-config.js` over the archive's `app-config.js`.
With `"pin": null` it writes a one-page stub saying the viewer is not pinned,
so `vp run pack` and the github-pages assembly stay green.

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

GitHub Pages serves real files only, so a fresh load of a mode URL such as
`/ohif-viewer/fhir-viewer?…` is a 404. Launch at the worklist, not the mode.

`?iss=` without `launch` sets the FHIR server without an OAuth redirect, for
standalone testing.

### Client ID

The SMART client ID is unsettled and left empty in `app-config.js`. Until a
registration is decided, the viewer takes it from `?client_id=` on the launch
URL or from its SMART Preferences panel (saved in the browser); once decided,
set `smartClientId` in the data source configuration. The FHIR server must
allow `https://wildflowerhealth.io` in CORS and register
`https://wildflowerhealth.io/ohif-viewer/` as the redirect URI.

## Updating the viewer

1. Bump the upstream pins in `ohif-viewer-dist` and let its workflow publish a
   release.
2. Copy the release's asset URL and the contents of `ohif-viewer.tar.gz.sha256`
   into `prebuilt.json`.
3. `vp run -F ohif-viewer build`, then `vp run -F github-pages build` to see it
   assembled; the PR preview shows it live.
