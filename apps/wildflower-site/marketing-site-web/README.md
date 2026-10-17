# marketing-site-web

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
- `privacy-policy/index.html`, `consumer-health-data/index.html`,
  `terms/index.html`, `deletion/index.html` — the four policy pages, built as
  extra Vite entries (`vite.config.ts`) so they are served at
  `/privacy-policy/`, `/consumer-health-data/`, `/terms/` and `/deletion/` (the paths in
  `branding-core`'s `POLICY_PATHS`, which the footer, the settings menus and
  the consent dialog link to). Their entry modules (`src/*-main.tsx`) render
  `src/pages/*` inside `components/policy-page.tsx`, which wraps the shared
  header and footer around one prose column. Google Play links to both pages
  for Wildflower Host, so keep them true of what the apps and the relay
  actually collect, and bump the `updated` date with any change.
- `src/mount-page.tsx` — the shared styles and `createRoot` every entry uses.
- `src/app-redirects.ts` — the apps' old paths on the apex (`/health-viewer/`,
  `/lifting/`, `/medications/`, …) and the page served at each, which sends
  the visitor on to the app's own origin with the query and fragment. The
  build's last step, `scripts/write-apex-pages.ts`, writes one into `dist/`
  per app, beside branding-core's `404.html`, which hands a deep link under
  one of those paths to its page, so bookmarks and SMART launch URLs naming
  the apex keep working.
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
  app-icon set in `apps/host/host-app/src-tauri/icons`; `public/CNAME` — the
  custom domain.
- `public/suggested_apps.json` — the SMART apps worth trying with a Wildflower
  server, published at `https://wildflowerhealth.io/suggested_apps.json`.
  Hand-edited; its schema is `suggested-apps-core-js`'s `SuggestedApps`.
  `src/suggested-apps.test.ts` decodes it and requires a first-party entry
  for each app in `branding-core`'s `SMART_APP_LAUNCH_PAGES`, at that launch
  page and with its `APP_DESCRIPTIONS` name and tagline, so a renamed or new
  hosted app fails there until the file follows. Nothing checks the
  `ohif-viewer` entry or any entry's scopes: those are copied by hand from
  each app's SMART config.

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
- **App copy is shared with the apps.** Plots,
  Medication Viewer, FHIR Sync for Pebble, Strength, Importer and Synthetic
  Data Loader rows read their status line, paragraphs and launcher text from
  `branding-core`'s `APP_DESCRIPTIONS`; each app's standalone landing page
  renders the same entry. Edit the copy there, not in the section components.
  The server rows stay inline.
- **Dark only.** The scheme attribute is pinned in `index.html`; no module
  carries a `prefers-color-scheme` block.

## Deployment

This site is the apex, `https://wildflowerhealth.io`:
`.github/workflows/deploy-github-pages.yml` builds it and deploys `dist/` to
this repository's Pages on every push to `main`, after every hosted app has
published to its own origin. It is served at the custom domain in
`public/CNAME` (`wildflowerhealth.io`), which the build copies to the root of
`dist/`, the only place Pages reads it from. Its links into the apps go to
each app's published origin, from a preview too. The Vite `base` is relative
(`./`) so the same build serves the apex and a PR preview's subpath.

A PR that changes this site gets a preview at
`https://wildflowerhealthio.github.io/staging/pr-<n>/`, published by
`pr-preview.yml` to `pr-<n>/` of `wildflowerhealthio/staging` and removed
when the PR closes.

One-time setup: repo Settings → Pages → Source = "GitHub Actions", then set the
custom domain to `wildflowerhealth.io`.
