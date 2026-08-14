# github-pages

Assembles everything published at <https://wildflower-health.io> into a single
static artifact. It owns no UI of its own: each section is built by the package
that owns it, and this package places those outputs at their public URLs.

| URL                | Source package                                 |
| ------------------ | ---------------------------------------------- |
| `/`                | `marketing-website` (`apps/marketing-website`) |
| `/medications-app` | `medications-app` (`apps/medications-app`)     |

Generated HTML documentation joins the layout at `/docs` in a later change.

## Why a separate package

GitHub Pages publishes exactly one artifact per site, so everything served from
the domain has to be staged into one directory tree. Each assembled section is a
workspace `devDependency` of this package, so the workspace's own build ordering
(`vp run pack`, i.e. `vp run --cache -r build`) builds every section before this
package's build stages them. Doing that here keeps each app's own build config
untouched — in particular the medications app keeps
building into `slices/apps/self-hosted-apps/medication`, where it is also
vendored as a Tauri resource. This package only copies from there.

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
resolves outside `dist/`, copies the sections' build outputs into
`dist/`, and fails if a required file (either `index.html`, the root `CNAME`, or
the medications app's `launch.html` SMART launch entry) is missing — a silently
empty upstream build never gets published. Running it on its own expects the
sections to have been built already; `vp run pack` guarantees that ordering.

## Structure

- `src/assembly.ts` — the published layout as data, plus the pure path
  resolution and verification helpers (unit-tested in `assembly.test.ts`).
- `src/assemble.ts` — the executable: filesystem copy plus the post-copy check.

## Deployment

`.github/workflows/deploy-github-pages.yml` runs the workspace build on every
push to `main`, and uploads `dist/` to GitHub Pages.
