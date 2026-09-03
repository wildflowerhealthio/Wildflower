# AGENTS.md — slices/branding

Shared Wildflower chrome for the app web surfaces: the full site header and
footer the apps render, a slim brand bar for SMART-launched apps and the Tauri
desktop shell, the app icon, and the layout tokens that position them. (The
marketing homepage renders its own page-local header/footer per its design; it
consumes only `AppIcon` and `branding-core`'s section paths from here.)

## Package roles

- **`branding-core`** — the pure layer: site origin, section paths (the deploy
  contract matching `apps/github-pages/src/assembly.ts`), navigation link data
  as discriminated unions, the `NavContext` type that lets the same header/footer
  resolve hrefs differently on the marketing site vs. from an app, the
  `anchorHref` resolver, and `APP_DESCRIPTIONS` — the per-app introduction copy
  (name, tagline, status, first-person "why" paragraphs, homepage anchor, and
  launch link text) that the homepage's app rows and each app's landing page
  both render.
- **`branding-react`** — the browser UI adapter: `SiteHeader`, `SiteFooter`,
  `BrandBar`, `AppIcon`, `AppLanding`, and the `branding-react/styles.css`
  layout tokens (`--content-max-width`, `--page-padding-x`, `--header-height`,
  `--radius-pill`).

## The app landing page

A SMART app visited without a launch (`apps/medications-app`,
`apps/importer-web`, `apps/web-trace`) renders `SiteHeader`, then `AppLanding`
inside `main`, then `SiteFooter`. `AppLanding` takes the app's `AppSectionId`
and its connect menu as children: it lays out the introduction from
`APP_DESCRIPTIONS` on the left (the app name as the page's `h1`, the tagline,
the paragraphs, and a "Read about the rest of the project" link to the app's
homepage anchor via `anchorHref(fromApp, …)`) beside the connect menu on the
right, stacking on phones. The status line is homepage-only: an app someone
has reached is usable. The connect menu's own heading is an `h2` for this
reason.

## The NavContext idea

All chrome components take a `NavContext` that says where the marketing page
lives relative to the current surface:

- `onMarketingSite` (`{ marketingBase: '' }`) — anchors resolve to fragment-only
  hrefs like `#built`.
- `fromApp` (`{ marketingBase: 'https://wildflowerhealth.io/' }`) — anchors
  resolve to absolute URLs like `https://wildflowerhealth.io/#built`.

The brand link in `SiteHeader` checks `marketingBase === ''` to choose between
`#top` (same page) and the full marketing URL.

## Consuming the styles

Import `branding-react/styles.css` once at the app root, **after**
`react-tundraish/styles.css` and **before** the app's own stylesheets. The order
only governs override precedence for same-named tokens; the layout tokens'
`var(--space-N)` references resolve at computed-value time whatever the sheet
order. In source mode the `*.module.css` rules arrive through the JS import
chain; in built consumers they are bundled into `dist/style.css` via the
`default` export condition.

## Deploy contract

`SECTION_PATHS` in `branding-core/src/site.ts` must match the `destPath` values
in `apps/github-pages/src/assembly.ts`. A mismatch breaks cross-section links on
the assembled GitHub Pages site. The core tests pin the exact five paths.

## Guardrails

- **This slice is Wildflower-specific.** Generic UI primitives belong in
  `global/react-tundraish`; this slice carries the brand identity, link data,
  and layout tokens that only make sense for Wildflower surfaces.
- **`branding-core` is the pure layer.** No DOM, no React, no platform imports.
  `branding-react` depends on `branding-core`, never the reverse.
- **`--header-height` must stay in sync with `.site-header__inner` padding and
  the icon size.** The derivation is `padding-top + padding-bottom + icon-size +
border = 71px`; see the comments in `styles.css` and `site-header.module.css`.
- **App copy lives in `APP_DESCRIPTIONS`, not in a component.** The homepage
  rows (`built`, `possible-today`, `dev-tools`) and the apps' landing pages
  render the same entries; editing the copy in one component would fork the
  story. The Synthesized Health Viewer and the server-docs row are not SMART
  apps with a landing page, so their copy stays inline on the homepage.
- **`SiteHeader`/`SiteFooter` are the apps' chrome; the homepage's is its
  own.** The homepage redesign gave `apps/marketing-website` a page-local
  header and footer (its design demands them), so it imports only `AppIcon`
  and `branding-core` from here. A change to the chrome the _apps_ render —
  header, footer, brand bar, icon, layout tokens — is still made in this
  slice, not in an app. The anchors in `HEADER_NAV_LINKS`/`FOOTER_*_LINKS`
  must exist as `id`s on the homepage (`branding-core`'s `MARKETING_ANCHORS`
  lists them; `apps/marketing-website`'s `app.test.tsx` asserts the homepage
  renders an element for every one of them).
- **`SiteHeader` matches the homepage header's look.** Static, no backdrop,
  one hairline — the two are meant to read as the same bar, so a visual
  change to either belongs in both `site-header.module.css` files. The two
  still differ in what they link to: the shared header carries
  `HEADER_NAV_LINKS` (back to the homepage's sections), the homepage's
  carries direct links into the four apps. `titleAs` picks the element
  wrapping the brand lockup — `'div'` by default so an app's own page
  heading stays the only `h1`; a surface whose brand _is_ the page heading
  passes `'h1'`.

## References

- [slices/AGENTS.md](../AGENTS.md) — slice layering rules.
- [Doc Comments Reference](../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions.
