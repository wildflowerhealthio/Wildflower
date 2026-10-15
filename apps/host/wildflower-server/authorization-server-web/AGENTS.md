# AGENTS.md — apps/host/wildflower-server/authorization-server-web

The **authorization pages**: the React pages the authorization server
([`authorization-server-rust`](../authorization-server-rust),
`wildflowerhealthio-authorization-server`) embeds in its binary and serves on
the server's own origin, so the address bar names the server being approved:

- the **consent card**, `consent.html`, served at
  `/oauth/authorize/{id}/consent`. The card itself is `authorization-react`'s
  `OAuthConsentCard`.
- the **device page**, `device.html`, served at `/oauth/device`: the RFC 8628
  `verification_uri`, and with `?user_code=` its `verification_uri_complete`.
  The code box and the card are `authorization-react`'s `DeviceCodeEntryForm`
  and `DeviceConsentCard`.

This package composes them over the Owner browser's session. See "Consent
card" and "Device page" in the
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
  patient search (`patient-search.ts`, FHIR `GET /Patient?name=`, each hit
  read as a `PatientMinimal`), and leaves
  for the callback the decision's answer carries, only an http(s) one
  (`src/client-callback.ts`). A browser that can't read the consent (`401`,
  `403`, `404`) goes to the wait page.
- `device.html` + `src/device/main.tsx` — the device page's entry: reads the
  `user_code` from its query (`user-code-query.ts`) and mounts `DevicePage`
  over the same runner.
- `src/device/device-page.tsx` — on load reads `GET /authorization/session`:
  with no session (`401`), or one whose scopes don't cover
  `Devices.DEVICE_CONSENT_SCOPES` (authorization-core), it says to approve the
  request on the device running the server and shows no code box. Otherwise
  it fills the code box from `user_code` but reads no request until the Owner
  presses Continue (RFC 8628 §5.4), then reads
  `GET /authorization/devices/{userCode}` and shows the card, which posts
  `/approve` or `/deny`. A `404` keeps the code box with an error; a `401` or
  `403` on the read or the decision (the session ended or changed since load)
  says to approve on the server too. The request stays pending in both cases.
  A request that expires before the decision shows `ExpiredDeviceConsent`'s
  copy in place of the card, then "Enter a new code", which goes back to an
  empty code box and drops `user_code` from the address bar so a reload
  doesn't refill it.
- `src/owner-browser-session.ts` — the runner: the authorization API's client
  and plain FHIR reads on the page's origin, with no `Authorization` header.
  The browser's `__Host-owner_browser_session` cookie rides every same-origin
  request, and the server's cookie→bearer layer presents its token. Every
  request carries `OWNER_BROWSER_SESSION_HEADER`
  (`Wildflower-Session: owner-browser`), so a browser also holding the FHIR web
  UI's `hfs_session` still acts as the Owner, not as the UI's user.
- `page-script-budget.ts` — the build plugin that fails `vp build` when a
  page's JavaScript, beside the shared React chunk, is over 150 KB gzipped.
- `vite.config.ts` — the page inputs, `base: '/oauth/'`, the shared `react`
  chunk and the budget.

## Traps

- **The server serves every file under
  `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.**
  No inline `<script>` or `<style>`, no `data:` URLs and no images. Fonts load
  from `/oauth/assets/`: `main.tsx` imports `react-tundraish/styles`, which
  brings the Atkinson Hyperlegible faces.
- **Only `/oauth/assets/*.js`, `*.css` and `*.woff2` are served.** An asset of
  any other type (an image, a `.woff`) 404s; keep the pages to scripts,
  stylesheets and `woff2` fonts.
- **Mind the budget.** Anything that imports the FHIR datatype registry
  (`@wildflowerhealthio/fhir-r4/data-types`, `/resources`, `fhir-r4-react`)
  brings `fast-check` and the whole registry into the page: read patients
  with `@wildflowerhealthio/fhir-r4/patient-minimal` (`PatientMinimal.Schema`
  and `displayName`), as `patient-search.ts` does, which loads only `effect`.
- **`dist/` is embedded at compile time.** Building
  `wildflowerhealthio-authorization-server` (and so the server and the host
  app) needs it: run `vp run -F @wildflowerhealthio/authorization-server-web build`
  first, or `scripts/ci/stub-embedded-bundles.sh authorization-server-web` for
  a placeholder. The crate's `build.rs` rebuilds it when `dist/` changes.
- **The APIs are same-origin only.** `vp dev` serves the page with no server
  behind it; the pages' behaviour is covered by `consent-page.test.tsx` and
  `device-page.test.tsx` against a stub server.

## References

- [apps/host/wildflower-server AGENTS.md](../AGENTS.md) — the crates beside it
- `authorization-server-rust/src/http/routes/oauth/authorization_pages.rs` —
  how the server serves the build
