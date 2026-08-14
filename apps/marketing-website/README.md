# marketing-website

The Wildflower Health marketing landing page — a standalone React + Vite
single-page site. It renders in the app's design language (react-tundraish:
true-neutral surfaces, the navy accent, Atkinson Hyperlegible throughout, and
the shared dark theme) composed as an editorial page rather than an app screen:
wide measure, generous stage spacing, prose first, no app chrome.

## Develop

```bash
vp dev      # start the dev server
vp check    # format, lint, typecheck
vp test     # run the Vitest suite (jsdom)
vp build    # production build to dist/
```

## Structure

- `src/app.tsx` — composes the page sections top to bottom.
- `src/components/*` — one component per section (`header`, `hero`,
  `convergence`, `steps`, `privacy`, `cta`, `footer`) plus the shared pieces
  (`app-icon`, `beta-form`, `phone-mockup`). Each pairs a `.tsx` with its own
  `*.module.css`.
- `src/data/convergence.ts` — the pure data + highlighting logic for the
  interactive "collection of apps" section (unit-tested in
  `convergence.test.ts`). It also carries each app's availability and, for an
  app published on this domain, its link.
- `src/styles/tokens.css` — the few page-composition variables the design
  system has no concept of.
- `src/styles/global.css` — page surface and the shared `.card` utility.
- `public/app-icon.png` (128px logo / apple-touch) and `public/favicon.png`
  (32px tab icon) — scaled from the shared app-icon set in
  `apps/wildflower-tauri/src-tauri/icons`; `public/CNAME` — the custom domain.

## Styling conventions

- **CSS Modules + BEM**: classes are `block`, `block__element`,
  `block--modifier`, scoped to each component's module file.
- **Design-system tokens first**: colours, type sizes, weights, spacing and
  radii come from react-tundraish's ramps (`--color-*`, `--font-size-N`,
  `--font-weight-N`, `--space-N`, `--radius-N`), read directly by the component
  modules. There is no site palette layered on top, and no bespoke type scale —
  a new value belongs on a ramp step, not in a literal.
- **Tundra primitives before bespoke CSS**: `.button button-N filled|outline`
  (the `button` class is required on an `<a>`), `.input-N`, `.sr-only`, and the
  site's own `.card`. A module should only add layout the primitive can't.
- `tokens.css` holds only what the design system has no concept of:
  - `--content-max-width` and `--page-padding-x` (the section gutter, retuned
    once at the `680px` breakpoint),
  - `--header-height` (the sticky header height section anchors offset their
    scroll target by),
  - `--beta-form-width` (shared by the hero and CTA forms) and `--radius-pill`.
- **Dark mode** is the shared theme: `color-scheme.ts` mirrors the OS
  preference onto `:root[data-color-scheme='dark']`, which is the only trigger
  react-tundraish's dark palette reads. No module carries a
  `prefers-color-scheme` block — a surface that must flip reads a token that
  already does.

## Deployment

This site is the root (`/`) of the published GitHub Pages artifact assembled by
`apps/github-pages`, which `.github/workflows/deploy-github-pages.yml` builds
and publishes on pushes to `main` that touch any assembled section. It is
served at the custom domain in `public/CNAME` (`wildflower-health.io`) — the
assembly copies that file to the artifact root. The Vite `base` is relative
(`./`) so the same build also works from the project URL while the domain's DNS
propagates.

One-time setup: repo Settings → Pages → Source = "GitHub Actions", then set the
custom domain to `wildflower-health.io`.
