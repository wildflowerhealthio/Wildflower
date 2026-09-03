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
  resolve hrefs differently on the marketing site vs. from an app, and the
  `anchorHref` resolver.
- **`branding-react`** — the browser UI adapter: `SiteHeader`, `SiteFooter`,
  `BrandBar`, `AppIcon`, `useHref`, and the `branding-react/styles.css` layout
  tokens (`--content-max-width`, `--page-padding-x`, `--header-height`,
  `--radius-pill`).

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
- **`SiteHeader`/`SiteFooter` are the apps' chrome; the homepage's is its
  own.** The homepage redesign gave `apps/marketing-website` a page-local
  header and footer (its design demands them), so it imports only `AppIcon`
  and `branding-core` from here. A change to the chrome the _apps_ render —
  header, footer, brand bar, icon, layout tokens — is still made in this
  slice, not in an app. The anchors in `HEADER_NAV_LINKS`/`FOOTER_*_LINKS`
  must exist as `id`s on the homepage (`branding-core`'s `MARKETING_ANCHORS`
  lists them; `apps/marketing-website`'s `app.test.tsx` pins the ids).

## References

- [slices/AGENTS.md](../AGENTS.md) — slice layering rules.
- [Doc Comments Reference](../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions.
