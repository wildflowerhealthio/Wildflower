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
  and `DeviceConsentCard`. It decides browser pairings too.
- the **pairing page**, `pair.html`, served at `/oauth/pair?next=…`: where a
  browser that isn't the Owner's signs in, by showing a code the Owner
  approves (a browser pairing).

This package composes them over the browser session. The host app
also opens either page with `?then=back`, in a browser signed in as the Owner,
to decide a request another browser or device made: after Allow or Deny the
page says how it went ("Approved. You can close this." or "Declined. You can
close this.") and steps back out (`history.back()` when there is history, else
`window.close()`) instead of leaving for the client callback or showing the
decision's own message. A Close button under that takes the step again, for a
browser that kept the page open (`DecidedThenBack`). On iOS the host closes
the page itself once the request settles. See "Consent
card" and "Device page" in the
[Jargon Explanation](../../../../slices/authorization/docs/Jargon%20Explanation.md).

`apps/relay/relay-admin-web` is the template for the shape (a Vite build into
the package's own `dist/`, embedded with `include_dir!`). What differs: one
HTML input per page, assets under `base: '/oauth/'`, and a stricter Content
Security Policy (below).

## Layout

- `consent.html` + `src/consent/main.tsx` — the consent card's entry: reads
  the request id from its path and `then` from its query
  (`src/then-query.ts`), and mounts `ConsentPage` over
  `browserSessionRunner(location.origin, FetchHttpClient.layer)`.
- `src/consent/consent-page.tsx` — reads the consent, renders the card with a
  patient search (`patient-search.ts`, FHIR `GET /Patient?name=`, each hit
  read as a `PatientMinimal`), and leaves
  for the callback the decision's answer carries, only an http(s) one
  (`src/client-callback.ts`). With `then=back` it leaves for no callback (the
  wait page in the browser that made the request finishes the flow): it shows
  the done message, then steps back out. A browser that can't read the
  consent (`401`, `403`) goes to the wait page, `then=back` or not; a
  request no longer pending (`404`) goes there too, except with `then=back`,
  where the page says it was already decided or expired and steps back out;
  any other failed read says so in plain words, never the error's text. A
  consent whose `missingApprovalScopes` isn't empty (the session can't approve
  it as asked) gets "Ask the server's owner" in place of Allow, and none of
  the card's decision controls; asking posts `…/ask-owner`, which raises the
  request so the host notifies the Owner, then leaves for the wait page, and a
  failed post says so in plain words. A device request whose
  `missingApprovalScopes` isn't empty says to approve it on the server's
  device.
- `device.html` + `src/device/main.tsx` — the device page's entry: reads the
  `user_code` (`user-code-query.ts`) and `then` (`src/then-query.ts`) from its
  query and mounts `DevicePage` over the same runner.
- `src/device/device-page.tsx` — on load reads `GET /authorization/session`:
  with no session (`401`), or one whose scopes don't cover
  `Devices.DEVICE_CONSENT_SCOPES` (authorization-core), it says to approve the
  request on the device running the server (its notification, or the
  server's page in the Wildflower app) and shows no code box; any other
  failed read says so in plain words, never the error's text. Otherwise
  it fills the code box from `user_code` but reads no request until the Owner
  presses Continue (RFC 8628 §5.4), then reads
  `GET /authorization/devices/{userCode}` and shows the card, which posts
  `/approve` or `/deny`. A `404` keeps the code box with an error; a `401` or
  `403` on the read or the decision (the session ended or changed since load)
  says to approve on the server too. The request stays pending in both cases.
  A request that expires before the decision shows `ExpiredDeviceConsent`'s
  copy in place of the card, then "Enter a new code", which goes back to an
  empty code box and drops `user_code` from the address bar so a reload
  doesn't refill it. With `then=back` a decision shows the done message in
  place of the decision's own, then steps back out; the "approve on the
  server" cases stay as they are.
- `pair.html` + `src/pair/main.tsx` — the pairing page's entry: reads `next`
  from its query (`next-query.ts`) and mounts `PairPage` over the same runner,
  leaving with `window.location.assign`.
- `src/pair/pair-page.tsx` — on load posts `/oauth/pair/start` with `next`
  (one start per attempt: a `useQuery` that never refetches), then shows the
  code, a name field filled from the start's `browserName`, and polls
  `/oauth/pair/poll` every `interval` with the name as it stands, waiting
  5 s longer after each `slow_down`. `approved` (whose answer set the session
  cookie) leaves for the `next` the start answered with; `denied`, `expired`
  or a `404` says so, with "Get a new code". A refused start
  (`BrowserPairingNextNotAllowed`, `BrowserSessionClientDisabled`) says why in
  plain words. The page judges no `next` itself: the server allows only a
  path on its own origin.
- `src/then-query.ts` — `goBackOnceDecidedOf`: the query's `then`, decoded at
  the entry into `Some` step back out of the window for `then=back` and
  `None` for anything else. The pages take it as the `goBackOnceDecided`
  prop, and the tests pass a spy. The pages render the done message before
  they call it, so a window the browser refuses to close still shows it.
- The authorization server's `401` has no body, as the client's declared
  `HttpApiError.Unauthorized` expects, so the pages see it as a `401`.
- `src/browser-session.ts` — the runner: the authorization API's client
  and plain FHIR reads on the page's origin, with no `Authorization` header.
  The browser's `__Host-browser_session` cookie rides every same-origin
  request, and the server's cookie→bearer layer presents its token. Every
  request carries `BROWSER_SESSION_HEADER`
  (`Wildflower-Session: browser`), so a browser also holding the FHIR web
  UI's `hfs_session` still acts in its browser session, not as the UI's user.
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
  behind it; the pages' behaviour is covered by `consent-page.test.tsx`,
  `device-page.test.tsx` and `pair-page.test.tsx` against a stub server.

## References

- [apps/host/wildflower-server AGENTS.md](../AGENTS.md) — the crates beside it
- `authorization-server-rust/src/http/routes/oauth/authorization_pages.rs` —
  how the server serves the build
