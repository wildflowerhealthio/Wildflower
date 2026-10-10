# server-docs-web

The static API console published at
<https://wildflowerhealth.io/server-docs>: an interactive
[Scalar](https://scalar.com) reference for the Wildflower server's HTTP API,
pointed at whichever running server the reader chooses.

It documents six slices, one sidebar group each, from the **committed OpenAPI
snapshots**:

| Sidebar group | Snapshot                                                                            |
| ------------- | ----------------------------------------------------------------------------------- |
| Gatekeeper    | `apps/host/wildflower-server/gatekeeper-rust/openapi/gatekeeper-oauth.openapi.json` |
| Apps          | `apps/host/wildflower-server/apps-rust/openapi/apps.openapi.json`                   |
| Databases     | `apps/host/wildflower-server/databases-rust/openapi/databases.openapi.json`         |
| Collector     | `apps/host/wildflower-server/collector-rust/openapi/collector.openapi.json`         |
| Request log   | `apps/host/wildflower-server/request-log-rust/openapi/request-log.openapi.json`     |
| FHIR R4       | `slices/fhir/fhir-r4/openapi/fhir-r4.openapi.json`                                  |

Those snapshots are the same files the per-slice Rust snapshot tests and the
`api-sync.yml` drift guard hold to the live routes, so publishing from them
needs no Rust toolchain in the Pages deploy and still cannot silently drift from
the server. See the
[OpenAPI Spec Drift How-To](../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md).

Nothing loads from a CDN: the Scalar reference comes from its npm package and
the specs are imported as modules, so the whole console is one self-contained
bundle.

A static brand bar above the server form links back to the Wildflower home
page. The icon (`public/app-icon.png`, copied from `apps/wildflower-site/marketing-site-web`)
and "Wildflower" wordmark match the look of `branding-react`'s `BrandBar`,
styled with the same palette the server bar already uses — no `branding-react`
dependency (this page is not React).

## The `?server=` contract

The console is a static page, so the API it documents is never its own origin.
The target lives in the URL:

```text
/server-docs                                      → http://127.0.0.1:8080
/server-docs?server=https://example-tunnel-origin → that origin
```

- Only absolute `http:` / `https:` URLs are accepted. Anything else —
  `javascript:`, `data:`, protocol-relative `//host`, a bare hostname — is
  rejected, and the console falls back to the default.
- The default is the loopback origin the desktop host's embedded server binds —
  `http://127.0.0.1:8080` today. It is **derived** from
  `apps/host/host-app/tauri-shared-config.json` (the same file the Rust host
  and the Tauri webview read), not restated here, so changing the port there
  changes this console too.
- The header bar's input writes the canonical target back into the URL, so a
  configured console is shareable as a link.
- Each spec is served to Scalar with that origin as its only `server` entry and
  with a bearer HTTP security scheme declared, so the UI offers a token field.
  The running host gates its admin surface on that bearer for every non-loopback
  caller; the snapshots themselves carry no security metadata because the host
  applies the gate as a layer.
- The target doubles as the SMART `iss` for signing in — see below.
- Opened with a SMART launch instead (`?iss=<FHIR base>`, with the EHR's
  `launch` when there is one), the console targets the server `iss` names: the
  FHIR base less a Wildflower server's `/fhir-r4` mount, over any `?server=`
  the link also carried. `iss` and `launch` are taken out of the URL and the
  target written in as `?server=` before anything reads it, and the console
  signs in straight away (see "Opened with a launch" below).

The document transforms and the Scalar configuration are pure functions in
`src/spec.ts` and `src/configuration.ts`, unit-tested beside them; the `?server=`
parsing itself lives in `gatekeeper-core/smart-client` (every static Wildflower
page that targets a reader-chosen server needs it), and `src/server-target.ts`
holds only this console's fallback — the desktop host's loopback origin.
`src/arrival.ts` holds how a load settles what it arrived with: the query it
leaves in the address bar after a launch or a return leg, and the sign-in
controls it resets when the back-forward cache restores it.
`src/main.ts` is the DOM and history wiring.

The configuration also turns off two Scalar defaults that would otherwise reach
third parties: its `web` layout proxies "send" through `https://proxy.scalar.com`
unless `proxyUrl` is set (that would hand a reader's request, bearer token
included, to a service we don't run — and could never reach a loopback server),
and `withDefaultFonts` pulls webfonts from `fonts.scalar.com`. Both are asserted
in `configuration.test.ts`.

## Signing in

The header bar's **Sign in** button runs a SMART standalone launch against the
chosen server, so "send request" works with a real token instead of one pasted
in by hand.

### The flow

1. **Discovery.** The console fetches
   `{server}/fhir-r4/.well-known/smart-configuration` for the `?server=` target
   and reads `authorization_endpoint` and `token_endpoint` out of it; the FHIR
   base that answered, `{server}/fhir-r4`, is the SMART `iss`. A Wildflower
   server answers that path from `apps/host/wildflower-server/fhir-r4-rust/src/smart_configuration.rs`
   (unauthenticated, exempt from the bearer gate) and points it at its own
   gatekeeper, whether it is served at an origin or behind a path prefix. Only
   if that answers 404 does the console try
   `{server}/.well-known/smart-configuration`, reading the target as a plain
   FHIR base. A target that is unreachable, answers with something else, or
   answers 404 at both fails here, and the reason is shown in the header bar.
2. **Authorization.** The console redirects to the `authorization_endpoint` as
   the public PKCE client `664a01e8614050cd82ffe90350b81413` — S256 challenge, random
   `state`, `aud` the FHIR base discovery found (`{server}/fhir-r4` for a
   Wildflower server), and the whole scope set the client is
   allowed to request. The Owner approves (or narrows) it on the server's own
   consent page; `allowed_scopes` is only the ceiling, so the grant is whatever
   they agree to.
3. **Redemption.** The server sends the browser back with `code` + `state`, the
   console checks the `state` against what it stashed, redeems the code at the
   `token_endpoint` with the PKCE verifier (no client secret — a static page
   keeps none), and prefills every source's bearer field with the access token.
   The authorization response is stripped from the address bar immediately,
   on a failed return as on a successful one: `code`, `state`, `error`,
   `error_description`, and the `iss` an authorization server may add to name
   itself (RFC 9207), all through `gatekeeper-core/smart-client`'s
   `searchWithoutAuthorizationResponse`.

Back from the authorization server can restore the console from the
back-forward cache as it left, its **Sign in** button disabled and the status
line asking the server how to sign in. On that restore (`pageshow` with
`persisted`) the button and status line start over.

The client is registered by
`apps/host/wildflower-server/gatekeeper-rust/migrations/0007_seed_wildflower_server_docs_client`
and re-keyed to that random id, with its redirect moved to `/server-docs/`, by
`0028_rekey_site_app_clients`;
`src/smart-client.ts` is the browser-side reading of that row's `client_id` and
`allowed_scopes`, and must match them. The **redirect URI is not read from
there** — see below.

Every fallible step of that is typed: the pure validation (discovery metadata,
the `state` round trip, the token response) returns an `Either` with a tagged
error on the left, the async edges (the discovery fetch, the PKCE digest, the
token POST) are `Effect`s failing with the same errors, and "this page load is
not a return leg" is an `Option`, not a failure. `main.ts` is the only place an
Effect is run: one handler renders any error's `reason` on the status line.

Scalar's own OAuth2 support is deliberately **not** used. It authorizes
per-document, so a six-slice console would ask the reader to sign in six times;
it drives the flow through a popup whose location it polls, which would boot a
second copy of this bundle inside the popup; and it generates `state` with
`Math.random`. The flow above is a few hundred lines of dependency-free code in
`gatekeeper-core/smart-client` (`smart-discovery.ts`, `pkce.ts`,
`authorization-flow.ts`, `sign-in.ts`), all unit-tested there and shared with the
hosted launcher, and it puts one token into all six documents through Scalar's
`authentication` configuration block. This console supplies the app-specific
half — client id, scopes and the `sessionStorage` key the pending record is
namespaced under — from `src/smart-client.ts`, and derives its redirect URI.

### Opened with a launch

A link carrying a SMART launch (`gatekeeper-core/smart-client`'s
`arrivingSmartLaunchFrom` reads it, as every Wildflower page a launch can open
does) starts the sign-in on load, with no click: an EHR's `launch` works once
and only for a few minutes. The authorization request carries that `launch`,
making it an EHR launch; a lone `iss` is a standalone launch against the
server it names. A target this page cannot reach (plain http off loopback,
from the https console) is not signed in to, and the status line says why. A
reload finds no launch left to spend, since it is gone from the URL.

### Where the token lives

**In one variable in `main.ts`, for the life of the tab.** Never
`localStorage`, never `sessionStorage`, never a cookie: this is a public origin
and the token can be admin-capable. Scalar's `persistAuth` — which would write
the whole auth block, token included, to `localStorage` — is explicitly off and
asserted off in `configuration.test.ts`. Signing out drops the variable; closing
the tab does the same. The spirit is the embedded store's in
[Auth Token Storage Explanation](../../slices/gatekeeper/docs/Auth%20Token%20Storage%20Explanation.md).

The one thing that does touch `sessionStorage` is the pending request — the PKCE
verifier, the `state` and the target server — because a full-page redirect
leaves nowhere else to keep it. It holds no credential, and it is deleted the
moment the console comes back, before the code is redeemed. Any refresh token
the server returns is discarded: there is no session to refresh into.

### Sign-in works from wherever the console is served

The console does not carry a list of addresses it is allowed to sign in from.
It **derives** its `redirect_uri` from where the page is being served, with
`gatekeeper-core/smart-client`'s `redirectUriForPage` — the page's own directory
URL, which is what the fhirclient-based apps (`apps/medications/medications-web`,
`apps/importer-web`) have always done. One build
therefore signs in from the published site, from a PR preview under
`https://wildflowerhealthio.github.io/staging/pr-<n>/server-docs/`,
and from `vp run -F server-docs-web dev`, with nothing to keep in step.

`/oauth/authorize` still matches `redirect_uri` by exact string equality, and
the seed carries only the published URL. The other addresses are **not**
rejected: for every client but the first-party host, an unregistered redirect
reaches the Owner's consent prompt as a "this redirect is new" warning, and
approving it adds the entry to the client row (`gatekeeper-rust`'s
`domain/client_registration.rs`). The Owner's consent is the gate — which is
the honest one, since a static page cannot know what a given server's row holds.

Two properties make the derivation safe to rely on, both pinned by tests in
`gatekeeper-core`:

- **It is stable across the round trip.** The value is derived from the page's
  directory, so the string sent to `/authorize` and the string derived again on
  the callback — which arrives carrying `code` and `state` — are identical.
  Exact matching is satisfied by construction.
- **It never downgrades.** Any `https:` page is accepted, and `http:` only on a
  loopback host (a dev server). A plaintext page elsewhere derives nothing,
  because the flow puts an access token in the browser.

Because the derived redirect URI carries no query string, `?server=` cannot ride
back in the URL: it travels in the stashed pending record and is restored when
the console returns.

One consequence worth knowing when using a preview: the console warns, at the
point the server address is entered, when a page served over https is pointed at
a plaintext non-loopback server, because the browser blocks that. Loopback is
unaffected — browsers treat `http://127.0.0.1` as trustworthy, which is what
lets the published HTTPS console drive a desktop host at all.

## The CORS caveat

Requests are sent **straight from the reader's browser** to the chosen server —
there is no proxy — so they are cross-origin and subject to the browser's rules:

- The Wildflower API applies one CORS layer across its whole surface
  (`api_cors_layer` in `apps/host/wildflower-server/wildflower-server-rust/src/http/middleware/cors.rs`),
  which mirrors the requesting origin and headers back rather than sending `*`,
  so the `Authorization` header is allowed and a cross-origin call from this
  page is accepted by the server.
- Targeting a **loopback** server from the HTTPS-published console is
  mixed content. Chromium and Safari treat `http://127.0.0.1` as a
  potentially-trustworthy origin and allow it; other browsers may block it. When
  a request fails with no response at all, that is the likely cause — run the
  console from `vp run -F server-docs-web dev` (an `http://localhost`
  origin) or point it at the server's public tunnel origin instead.
- The server also gates on a loopback peer address: a forwarded request only
  passes through the tunnel relay. Pointing this console at a device's loopback
  from another machine cannot work, whatever CORS says.

## Development

```bash
vp run -F server-docs-web dev     # local dev server
vp run -F server-docs-web build   # bundle into dist/
vp test                                  # unit tests for the parsing/transforms
```

`apps/wildflower-site/wildflower-site-web` copies `dist/` to `/server-docs` in the published
artifact; the build uses a relative `base` so the assets resolve from that
sub-path.
