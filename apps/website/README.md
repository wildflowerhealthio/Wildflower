# website

The Wildflower Health marketing landing page — a standalone React + Vite
single-page site. Warm, editorial, vintage-botanical; not the clinical app UI.

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
  interactive "how it works" section (unit-tested in `convergence.test.ts`).
- `src/styles/tokens.css` — design tokens and cross-cutting CSS variables.
- `src/styles/global.css` — reset, page surface, shared typography.
- `public/app-icon.png` (128px logo / apple-touch) and `public/favicon.png`
  (32px tab icon) — scaled from the shared app-icon set in
  `apps/wildflower-tauri/src-tauri/icons`; `public/CNAME` — the custom domain.

## Styling conventions

- **CSS Modules + BEM**: classes are `block`, `block__element`,
  `block--modifier`, scoped to each component's module file.
- **CSS variables** (`tokens.css`) hold anything shared by two or more
  components, or that two rules must agree on — colours, fonts, radii, plus the
  load-bearing layout tokens:
  - `--content-max-width` and `--page-padding-x` (the section gutter; the mobile
    app-pill rail cancels it with a negative margin to bleed full-width, and the
    `680px` breakpoint retunes it in one place),
  - `--header-height` (the sticky header height the Convergence sticky selector
    pins directly under, and that section anchors offset their scroll target by).

## Deployment

`.github/workflows/deploy-website.yml` builds and publishes the site to GitHub
Pages on pushes to `main` that touch `apps/website/**`. It is served at the
custom domain in `public/CNAME` (`wildflower-health.io`). The Vite `base` is
relative (`./`) so the same build also works from the project URL while the
domain's DNS propagates.

One-time setup: repo Settings → Pages → Source = "GitHub Actions", then set the
custom domain to `wildflower-health.io`.
