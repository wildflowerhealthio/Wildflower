# AGENTS.md — slices/branding

Shared Wildflower chrome for every web surface — the marketing homepage and the
apps alike: the full site header and footer, a slim brand bar for SMART-launched
apps and the Tauri desktop shell, the app icon, and the layout tokens that
position them. The homepage and the apps render the **same** `SiteHeader` /
`SiteFooter`; only the `NavContext` differs, so links resolve root-relative on
the homepage and absolute from an app.

## Package roles

- **`branding-core`** — the pure layer: site origin, section paths (the deploy
  contract matching `apps/github-pages/src/assembly.ts`), navigation link data
  as discriminated unions (anchor, absolute, and section links), the `NavContext`
  type that lets the same header/footer resolve hrefs differently on the
  marketing site vs. from an app, the `anchorHref` / `sectionHref` / `navHref`
  resolvers, and `APP_DESCRIPTIONS` — the per-app introduction copy
  (name, tagline, status, first-person "why" paragraphs, homepage anchor, and
  launch link text) that the homepage's app rows and each app's landing page
  both render. It also owns `restoreRedirectedUrl` — the app half of the GitHub
  Pages 404 contract (see "The 404 redirect" below).
- **`branding-react`** — the browser UI adapter: `SiteHeader`, `SiteFooter`,
  `BrandBar`, `AppIcon`, `AppLanding`, and the `branding-react/styles.css`
  layout tokens (`--content-max-width`, `--page-padding-x`, `--header-height`,
  `--radius-pill`, `--prose-max-width`, and the `--shadow-float-panel` used by
  the header's collapsed nav dropdown).

## The 404 redirect

GitHub Pages serves one `404.html` for every path it has no file for.
`apps/github-pages/404.html` probes ancestor directories for an `index.html`,
redirects to the deepest one that answers, and passes the requested path along,
site-absolute, as `?redirect=<path>` (an app-relative route named like the
app's own directory, `/app` below `/app/`, would read as the app root).
`restoreRedirectedUrl(window)` is the other half: each
first-party SPA entry (`apps/medications-app`, `apps/importer-web`,
`apps/web-trace`, `apps/wildflower-server-docs`) calls it as its first statement,
before the router, the SMART callback check, or the `?server=` read — it puts
the route back in the address bar with `history.replaceState` and drops the
`redirect` parameter, leaving every other parameter and the fragment alone.

`apps/ohif-viewer` is the exception: it is a prebuilt bundle with no entry
module of ours, so `config/app-config.js` hand-rolls the same steps. The two
must stay in step — `spa-redirect.ts` is the reference.

A dev server has no `404.html`, and Vite's SPA fallback serves `index.html` at
the deep path itself, so an entry that takes its basename from the path it
loaded at (`apps/wildflower-react`'s `main-web`) would boot under the wrong
basename. `redirectedUrl` is the redirect `404.html` performs, for a server
that knows the basename; `apps/wildflower-react`'s dev-server plugin
(`src/dev-server/deep-link-redirect.ts`) applies it so a dev deep link takes
the same `?redirect=` detour as the published site.

## The app landing page

A SMART app visited without a launch (`apps/medications-app` and
`apps/importer-web` through `fhir-r4-react/app-shell`'s `SmartAppRoot`, and
`apps/web-trace`) renders `SiteHeader`, then `AppLanding`
inside `main`, then `SiteFooter`. `AppLanding` takes the app's `AppSectionId`
and its connect menu as children: it lays out the introduction from
`APP_DESCRIPTIONS` on the left (the app name as the page's `h1`, the tagline,
the paragraphs, and a "Read about the rest of the project" link to the app's
homepage anchor via `anchorHref(fromApp, …)`) beside the connect menu on the
right, stacking on phones. The status line is homepage-only: an app someone
has reached is usable. The optional `guide` (a titled, numbered how-to with a
closing note — the Importer's HAR-capture steps) is the reverse: landing-only,
rendered after the paragraphs, never on the homepage. The connect menu's own heading is an `h2` for this
reason.

## The NavContext idea

All chrome components take a `NavContext` that says where the marketing page
lives relative to the current surface:

- `onMarketingSite` (`{ marketingBase: '' }`) — anchors resolve to fragment-only
  hrefs like `#built`; section links resolve to root-relative paths like
  `/medications-app` (so they keep working on preview/staging deploys).
- `fromApp` (`{ marketingBase: 'https://wildflowerhealth.io/' }`) — anchors
  resolve to absolute URLs like `https://wildflowerhealth.io/#built`; section
  links to absolute URLs like `https://wildflowerhealth.io/medications-app` (so a
  self-hosted app bundle points back at the canonical site).

`navHref` dispatches over the link kind; the brand link and section links both
check `marketingBase === ''` to choose between the same-origin and absolute form.

## Consuming the styles

Import `branding-react/styles.css` once at the app root, **after**
`react-tundraish/styles.css` and **before** the app's own stylesheets. The order
only governs override precedence for same-named tokens; the layout tokens'
`var(--space-N)` references resolve at computed-value time whatever the sheet
order. In source mode the `*.module.css` rules arrive through the JS import
chain; in built consumers they are bundled into `dist/style.css` via the
`default` export condition. A self-hosted SMART app on `fhir-r4-react/app-shell`
gets this stylesheet, in this order, from the shell's
`fhir-r4-react/app-shell/styles` rather than importing it itself.

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
- **`SiteHeader`/`SiteFooter` are the one chrome, used by the homepage and the
  apps.** `apps/marketing-website` consumes them just like the apps do (passing
  `onMarketingSite`); it no longer keeps a page-local header/footer. A change to
  the chrome — header, footer, brand bar, icon, layout tokens — is made once, in
  this slice, and every surface picks it up. Both the homepage and the apps show
  `HEADER_NAV_LINKS` (direct links into the four apps); only href resolution
  differs by `NavContext`. The `SiteFooter` is the minimal "not a company"
  footer (paragraph + contact + mono stamp) carrying `id="note"`; the homepage's
  `app.test.tsx` asserts an element exists for every `MARKETING_ANCHORS` id
  (`#note` among them, plus the anchors `AppLanding`'s "rest of the project"
  links resolve to).
- **`SiteHeader` is static, no backdrop, one hairline.** The four app links sit
  inline at ≥840px and collapse behind a hamburger dropdown below that. `titleAs`
  picks the element wrapping the brand lockup — `'div'` by default so an app's
  own page heading (and the homepage's hero manifesto) stays the only `h1`; a
  surface whose brand _is_ the page heading passes `'h1'`.

## References

- [slices/AGENTS.md](../AGENTS.md) — slice layering rules.
- [Doc Comments Reference](../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions.
