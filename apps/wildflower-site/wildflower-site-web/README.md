# wildflower-site-web

Assembles everything published under <https://wildflowerhealth.io> into one
static site, then splits it into the sites GitHub Pages serves. It owns no UI
of its own: each section is built by the package that owns it, and this
package places those outputs.

The marketing site is served at the apex, and every hosted app on an origin of
its own, `https://<slug>.wildflowerhealth.io/`, so no app can read another's
`localStorage`. The slug is `APP_SLUGS` in `branding-core`:

| Published at                                | Source package                                                        |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `wildflowerhealth.io/`                      | `marketing-site-web` (`apps/wildflower-site/marketing-site-web`)      |
| `wildflowerhealth.io/privacy-policy/`       | `marketing-site-web` (`apps/wildflower-site/marketing-site-web`)      |
| `wildflowerhealth.io/consumer-health-data/` | `marketing-site-web` (`apps/wildflower-site/marketing-site-web`)      |
| `wildflowerhealth.io/terms/`                | `marketing-site-web` (`apps/wildflower-site/marketing-site-web`)      |
| `wildflowerhealth.io/deletion/`             | `marketing-site-web` (`apps/wildflower-site/marketing-site-web`)      |
| `medications.wildflowerhealth.io/`          | `medications-web` (`apps/medications/medications-web`)                |
| `importer.wildflowerhealth.io/`             | `importer-web` (`apps/importer-web`)                                  |
| `server-docs.wildflowerhealth.io/`          | `server-docs-web` (`apps/server-docs-web`)                            |
| `ohif-viewer.wildflowerhealth.io/`          | `ohif-viewer-web` (`apps/ohif-viewer-web`)                            |
| `fhir-sync-pebble.wildflowerhealth.io/`     | `fhir-sync-pebble-web` (`apps/fhir-sync-pebble/fhir-sync-pebble-web`) |
| `plots.wildflowerhealth.io/`                | `plots-web` (`apps/plots/plots-web`)                                  |
| `synthetic-data.wildflowerhealth.io/`       | `synthetic-data-web` (`apps/synthetic-data/synthetic-data-web`)       |
| `strength.wildflowerhealth.io/`             | `strength-web` (`apps/strength/strength-web`)                         |
| `watch-lifts.wildflowerhealth.io/`          | `watch-lifts-web` (`apps/watch-lifts/watch-lifts-web`)                |
| `launcher.wildflowerhealth.io/`             | `launcher-web` (`apps/launcher/launcher-web`, `dist-web`)             |
| `authorization.wildflowerhealth.io/`        | `authorization-web` (`apps/authorization/authorization-web`)          |

## The assembled site and the published sites

`assemble.ts` builds one site in `dist/`: the marketing site at its root and
each app in its slug's directory (`src/assembly.ts`; a drift-guard test in
`assembly.test.ts` holds every `destPath` to `APP_SLUGS` and pins the literal
values). A PR preview publishes that site as is, so every app of a preview
sits under the same `…/staging/pr-<n>/`, and the preview's links stay in it
(`branding-core`'s `siteRootFor`).

`stage-published.ts` splits `dist/` into `dist-published/`:

- `apex/` — the marketing site, `404.html` and the marketing build's `CNAME`,
  plus a redirect stub at each app's old path on the apex
  (`APEX_REDIRECT_PATHS` in `src/published-sites.ts`: `/<slug>/`, except
  `/health-viewer/` for Plots and `/lifting/` for Strength). A stub replaces
  itself with the app's own origin, keeping the query and fragment, so
  bookmarks and SMART launch URLs naming the apex keep working; a deep link
  the apex's `404.html` handed over arrives at the app with the old path taken
  off its `?redirect=`.
- `apps/<slug>/` — each app's build, with a `CNAME` naming its origin,
  `.nojekyll` and `404.html`. Pages reads `CNAME` and `.nojekyll` only from
  the root of the branch it publishes, so each site carries its own.

## The 404 redirect

GitHub Pages serves one `404.html` for every path it has no file for, so a deep
link into any app (`/fhir-viewer?iss=…` on the OHIF viewer's origin, or
`…/pr-<n>/ohif-viewer/fhir-viewer?iss=…` in a preview) would otherwise land on
an error page. `404.html` — staged at the root of every published site by
`assemble.ts` and `stage-published.ts`, not by any section — probes ancestor directories for an
`index.html`, redirects to the deepest one that answers, and hands the requested
path over, site-absolute, as `?redirect=<path>` alongside whatever query the
link carried. Site-absolute because an app-relative route named like the app's
own directory (`/launcher` below `/launcher/`) would read as the app root.

When no ancestor answers, the page shows a plain "Page not found" message instead
of redirecting. In production every site's root answers, so this only happens
on staging, which has nothing at its root: a link into a closed PR preview, or a
staging URL outside any preview.

While it probes, the page paints the design system's `--color-canvas` for the
visitor's `prefers-color-scheme`, so dark-mode users don't see a white flash;
`assembly.test.ts` pins those colors to `react-tundraish`'s palette.

Completing that redirect is the app's half of the contract. Every first-party
SPA calls `restoreRedirectedUrl(window)` (from `branding-core`) as the first
statement of its entry module, which rewrites the address bar with
`history.replaceState` before the router or the SMART callback check reads the
URL. `ohif-viewer-web` is a prebuilt bundle with no entry module of ours, so its
`config/app-config.js` hand-rolls the same steps.

## Why a separate package

GitHub Pages publishes one tree per site, so every site has to be staged as a
directory tree of its own. Each assembled section is a
workspace `devDependency` of this package, so the workspace's own build ordering
(`vp run pack`, i.e. `vp run --cache -r build`) builds every section before this
package's build stages them. Doing that here keeps each app's own build config
untouched: every section builds into its own package — the medications app, the
Importer, FHIR Sync for Pebble, Strength and the
server-docs console into their default `dist/`, the launcher into `dist-web/` — and this package only copies
from there. The OHIF viewer's `dist/` is a downloaded prebuilt bundle (or a stub
page while none is pinned) rather than a Vite build, and is copied verbatim too.

Each of the four SMART apps sets a relative `base: './'` in its own Vite
config, which is what lets the same build serve from its own origin's root,
from a preview's subpath and from a loopback origin's root under its dev
server.

The apex's `CNAME` file comes from `marketing-site-web`'s `public/` and lands
at the root of the apex site, which is the only place GitHub Pages reads it
from; `stage-published.ts` writes each app's.

## Build

```bash
vp run pack                    # builds every section, then assembles dist/
vp run -F @wildflowerhealthio/wildflower-site-web build   # assembles dist/ from already-built sections
vp run -F @wildflowerhealthio/wildflower-site-web stage-published   # splits dist/ into dist-published/
vp test                        # unit tests for the layout
```

`build` is `src/assemble.ts`, which refuses to write anything if the layout
resolves outside `dist/`, copies the sections' build outputs into `dist/`, and
fails if a required file (a section's `index.html` or the root `CNAME`) is
missing — a silently empty upstream build never gets published. Running
it on its own expects the
sections to have been built already; `vp run pack` guarantees that ordering.

## Structure

- `src/assembly.ts` — the published layout as data, plus the pure path
  resolution and verification helpers (unit-tested in `assembly.test.ts`).
- `src/assemble.ts` — the executable: filesystem copy plus the post-copy check.
- `src/published-sites.ts` — the published sites as data: each app's site, the
  apex redirect paths and the stub page (unit-tested in
  `published-sites.test.ts`, which also holds the deploy workflow's repository
  list to `APP_SLUGS`).
- `src/stage-published.ts` — the executable that stages `dist-published/`.

## Deployment

`.github/workflows/deploy-github-pages.yml` runs on every push to `main`: the
workspace build, then `stage-published`. It force-pushes each
`dist-published/apps/<slug>/` as the single commit of the `gh-pages` branch of
`wildflowerhealthio/<slug>-web` (whose Pages publishes that branch at the
app's origin), with a token from the GitHub App behind the `STAGING_APP_ID`
secret, and then deploys `dist-published/apex/` to this repository's Pages.
Each app repository's `main` holds only a README.

`.github/workflows/pr-preview.yml` publishes the same `dist/` into
`pr-<n>/` of the `wildflowerhealthio/staging` Pages site. There the artifact's
`404.html` lands at `pr-<n>/404.html`, which Pages never serves, so the workflow
also syncs `404.html` to the staging repo root. One copy covers every preview,
because the redirect probes ancestor paths site-absolutely.
