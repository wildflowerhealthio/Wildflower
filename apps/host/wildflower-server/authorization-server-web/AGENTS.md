# AGENTS.md — apps/host/wildflower-server/authorization-server-web

The **authorization pages**: the React pages the authorization server
([`authorization-server-rust`](../authorization-server-rust),
`wildflowerhealthio-authorization-server`) embeds in its binary and serves on
the server's own origin, so the address bar names the server being approved.
Today that is the **consent card**, `consent.html`, served at
`/oauth/authorize/{id}/consent`. The card itself is `authorization-react`'s
`OAuthConsentCard`; this package composes it over the Owner browser's session.
See "Consent card" in the
[Jargon Explanation](../../../../slices/authorization/docs/Jargon%20Explanation.md).

`apps/relay/relay-admin-web` is the template for the shape (a Vite build into
the package's own `dist/`, embedded with `include_dir!`). What differs: one
HTML input per page, assets under `base: '/oauth/'`, and a stricter Content
Security Policy (below).

## Layout

- `consent.html` + `src/consent/main.tsx` — the consent card's entry: reads
  the request id from its path and mounts `ConsentPage` over
  `ownerBrowserSessionRunner(location.origin, FetchHttpClient.layer)`.
- `src/consent/consent-page.tsx` — reads the consent, renders the card with a
  patient search (`patient-search.ts`, FHIR `GET /Patient?name=`), and leaves
  for the callback the decision's answer carries, only an http(s) one
  (`src/client-callback.ts`). A browser that can't read the consent (`401`,
  `403`, `404`) goes to the wait page.
- `src/owner-browser-session.ts` — the runner: the authorization API's client
  and plain FHIR reads on the page's origin, with no `Authorization` header.
  The browser's `__Host-owner_browser_session` cookie rides every same-origin
  request, and the server's cookie→bearer layer presents its token.
- `page-script-budget.ts` — the build plugin that fails `vp build` when a
  page's JavaScript, beside the shared React chunk, is over 150 KB gzipped.
- `vite.config.ts` — the page inputs, `base: '/oauth/'`, the shared `react`
  chunk and the budget.

## Traps

- **The server serves every file under
  `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.**
  No inline `<script>` or `<style>`, no `data:` URLs, no images and no fonts:
  `main.tsx` imports `tundra-css` and `react-tundraish/styles.css`, not
  `react-tundraish/styles`, which would load the Atkinson faces.
- **Only `/oauth/assets/*.js` and `*.css` are served.** An asset of any other
  type (an image, a font) 404s; keep the pages to scripts and stylesheets.
- **Mind the budget.** Anything that imports the FHIR datatype registry
  (`@wildflowerhealthio/fhir-r4/data-types`, `/resources`, `fhir-r4-react`)
  brings `fast-check` and the whole registry into the page: read FHIR through
  narrowed schemas, as `patient-search.ts` does, and show names with
  `@wildflowerhealthio/fhir-r4/human-name-display`.
- **`dist/` is embedded at compile time.** Building
  `wildflowerhealthio-authorization-server` (and so the server and the host
  app) needs it: run `vp run -F @wildflowerhealthio/authorization-server-web build`
  first, or `scripts/ci/stub-embedded-bundles.sh authorization-server-web` for
  a placeholder. The crate's `build.rs` rebuilds it when `dist/` changes.
- **The APIs are same-origin only.** `vp dev` serves the page with no server
  behind it; the page's behaviour is covered by `consent-page.test.tsx` against
  a stub server.

## References

- [apps/host/wildflower-server AGENTS.md](../AGENTS.md) — the crates beside it
- `authorization-server-rust/src/http/routes/oauth/authorization_pages.rs` —
  how the server serves the build
