# marketing-website

The Wildflower Health Project homepage — a standalone React + Vite single-page
site. It is a first-person essay, deliberately not a startup landing page: it
establishes the problem through the author's own medical record, explains FHIR
and SMART on FHIR, presents the apps as things that exist rather than products
being sold, makes three policy asks, and ends on a plain contact line. There is
no signup form, no pricing, and no marketing CTA buttons — every call to action
is a text link into an app. Keep that restraint; it is the design (see
`.local-notes/design_handoff_wildflower_home`).

It renders in the app's design language (react-tundraish: true-neutral
surfaces, the navy accent, Atkinson Hyperlegible Next/Mono), pinned to the
**dark scheme only** — `index.html` sets `data-color-scheme="dark"` on
`<html>`, and no OS-scheme listener runs.

## Develop

```bash
vp dev      # start the dev server
vp check    # format, lint, typecheck
vp test     # run the Vitest suite (jsdom)
vp build    # production build to dist/
```

## Structure

- `src/app.tsx` — composes the page top to bottom: header, hero (`#top`), the
  FHIR explainer, the apps (`#built`), the infrastructure (`#try`), the policy
  asks (`#asks`), dev tooling (`#developers`), footer (`#note`).
- `src/components/*` — one component per section (`hero`, `same-language`,
  `built`, `possible-today`, `asks`, `dev-tools`) plus the page's own chrome
  (`site-header`, `site-footer`) and shared pieces (`app-row`, `launcher`,
  `layout.module.css`). Each `.tsx` pairs with a `*.module.css`.
- `src/count-up.ts` — the stats count-up animation (reads its targets from the
  rendered DOM; respects `prefers-reduced-motion`; unit- and property-tested in
  `count-up.test.ts`).
- `src/assets/remote-images.ts` — **temporary** remote URLs for the portrait
  and the four consent-flow screenshots; swap to committed assets here once a
  home for them is decided.
- `src/styles/tokens.css` — the page-composition variables the design system
  does not provide (content column, gutter, prose measures).
- `src/styles/global.css` — page surface, global link/hover/selection styling.
- `public/app-icon.png` / `public/favicon.png` — scaled from the shared
  app-icon set in `apps/wildflower-tauri/src-tauri/icons`; `public/CNAME` — the
  custom domain.

## Styling conventions

- **CSS Modules + BEM**: classes are `block`, `block__element`,
  `block--modifier`, scoped to each component's module file.
- **Design-system tokens first**: colours, type sizes, weights, spacing and
  radii come from react-tundraish's ramps (`--color-*`, `--font-size-N`,
  `--font-weight-N`, `--space-N`, `--radius-N`), read directly by the component
  modules. The homepage design was derived from the dark palette, so its
  colours map 1:1; freehand sizes from the handoff are rounded onto ramp rungs.
  The handful of values with no rung (the 92px section-padding ceiling, the
  stats card's ambient shadow, the 28px stat line-height) stay literal, with a
  comment.
- **Page chrome is page-local.** The homepage renders its own static header
  (the `h1` wordmark plus direct links into the four apps) and its own quiet
  footer; only `AppIcon` and the `branding-core` section paths come from the
  branding slice. The shared `SiteHeader`/`SiteFooter` in `branding-react`
  remain the chrome for the _apps_, which link back to this page's anchors.
- **Dark only.** The scheme attribute is pinned in `index.html`; no module
  carries a `prefers-color-scheme` block.

## Deployment

This site is the root (`/`) of the published GitHub Pages artifact assembled by
`apps/github-pages`, which `.github/workflows/deploy-github-pages.yml` builds
and publishes on pushes to `main` that touch any assembled section. It is
served at the custom domain in `public/CNAME` (`wildflowerhealth.io`) — the
assembly copies that file to the artifact root. The Vite `base` is relative
(`./`) so the same build also works from the project URL while the domain's DNS
propagates.

One-time setup: repo Settings → Pages → Source = "GitHub Actions", then set the
custom domain to `wildflowerhealth.io`.
