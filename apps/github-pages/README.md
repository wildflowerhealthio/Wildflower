# github-pages

Assembles everything published at <https://wildflowerhealth.io> into a single
static artifact. It owns no UI of its own: each section is built by the package
that owns it, and this package places those outputs at their public URLs.

| URL                       | Source package                                           |
| ------------------------- | -------------------------------------------------------- |
| `/`                       | `marketing-website` (`apps/marketing-website`)           |
| `/medications-app`        | `medications-app` (`apps/medications-app`)               |
| `/importer-app`           | `wildflower-importer` (`apps/importer-web`)              |
| `/wildflower-server-docs` | `wildflower-server-docs` (`apps/wildflower-server-docs`) |
| `/web-trace-app`          | `wildflower-web-trace` (`apps/web-trace`)                |
| `/ohif-viewer`            | `ohif-viewer` (`apps/ohif-viewer`)                       |
| `/app`                    | `wildflower-react` (`apps/wildflower-react`, `dist-web`) |

Generated HTML documentation joins the layout at `/docs` in a later change.

The `destPath` of every section is derived from `SECTION_PATHS` (exported by
`branding-core`), the single source of truth for the deploy contract. A
drift-guard test in `assembly.test.ts` asserts that the set of `destPath`s
matches `Object.values(SECTION_PATHS)` and pins the literal values.

## The 404 redirect

GitHub Pages serves one `404.html` for every path it has no file for, so a deep
link into any section (`/web-trace-app/captures`, `/ohif-viewer/fhir-viewer?iss=…`)
would otherwise land on an error page. `404.html` — staged into the artifact
root by `assemble.ts`, not by any section — probes ancestor directories for an
`index.html`, redirects to the deepest one that answers, and hands the leftover
route over as `?redirect=<route>` alongside whatever query the link carried.

While it probes, the page paints the design system's `--color-canvas` for the
visitor's `prefers-color-scheme`, so dark-mode users don't see a white flash;
`assembly.test.ts` pins those colors to `react-tundraish`'s palette.

Completing that redirect is the app's half of the contract. Every first-party
SPA calls `restoreRedirectedUrl(window)` (from `branding-core`) as the first
statement of its entry module, which rewrites the address bar with
`history.replaceState` before the router or the SMART callback check reads the
URL. `ohif-viewer` is a prebuilt bundle with no entry module of ours, so its
`config/app-config.js` hand-rolls the same steps.

## Why a separate package

GitHub Pages publishes exactly one artifact per site, so everything served from
the domain has to be staged into one directory tree. Each assembled section is a
workspace `devDependency` of this package, so the workspace's own build ordering
(`vp run pack`, i.e. `vp run --cache -r build`) builds every section before this
package's build stages them. Doing that here keeps each app's own build config
untouched — in particular the medications app, the Web Trace app and the
Importer keep building into `slices/apps/self-hosted-apps/medication`,
`slices/apps/self-hosted-apps/web-trace` and
`slices/apps/self-hosted-apps/importer`, where they are also vendored as Tauri
resources. Those paths are each a seeded app row's (or its debug-only `-dev`
row's) `content_folder`, so this package only copies from them rather than
redirecting them. The server-docs console builds into its own `dist/` and is
copied verbatim, and so is the OHIF viewer, whose `dist/` is a downloaded
prebuilt bundle (or a stub page while none is pinned) rather than a Vite build.

Each of those three apps sets a relative `base: './'` in its own Vite config,
which is what lets the same build serve from a loopback origin's root on device
and from a subpath here.

The `CNAME` file (the custom domain) comes from `marketing-website`'s `public/`
and lands at the root of the artifact, which is the only place GitHub Pages
reads it from.

## Build

```bash
vp run pack                    # builds every section, then assembles dist/
vp run -F github-pages build   # assembles dist/ from already-built sections
vp test                        # unit tests for the layout
```

`build` is `src/assemble.ts`, which refuses to write anything if the layout
resolves outside `dist/`, copies the sections' build outputs into `dist/`, and
fails if a required file (a section's `index.html`, the root `CNAME`, or the
`launch.html` SMART launch entry of the medications, Web Trace and Importer
apps) is missing — a silently empty upstream build never gets published. Running
it on its own expects the
sections to have been built already; `vp run pack` guarantees that ordering.

## Structure

- `src/assembly.ts` — the published layout as data, plus the pure path
  resolution and verification helpers (unit-tested in `assembly.test.ts`).
- `src/assemble.ts` — the executable: filesystem copy plus the post-copy check.

## Deployment

`.github/workflows/deploy-github-pages.yml` runs the workspace build on every
push to `main`, and uploads `dist/` to GitHub Pages.
