# AGENTS.md — slices/branding

Shared Wildflower chrome for every web surface: the marketing site's full header
and footer, a slim brand bar for SMART-launched apps and the Tauri desktop shell,
the app icon, and the layout tokens that position them. A later migration wave
replaces the marketing site's local copies with imports from this slice.

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
  hrefs like `#how`.
- `fromApp` (`{ marketingBase: 'https://wildflowerhealth.io/' }`) — anchors
  resolve to absolute URLs like `https://wildflowerhealth.io/#how`.

The brand link in `SiteHeader` checks `marketingBase === ''` to choose between
`#top` (same page) and the full marketing URL.

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
- **Do not modify `apps/marketing-website` in a branding-slice PR.** The
  marketing site keeps its local copies until the consumer-migration wave
  replaces them with imports from this slice.

## References

- [slices/AGENTS.md](../AGENTS.md) — slice layering rules.
- [Doc Comments Reference](../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions.
