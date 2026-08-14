# wildflower-server-docs

The static API console published at
<https://wildflower-health.io/wildflower-server-docs>: an interactive
[Scalar](https://scalar.com) reference for the Wildflower server's HTTP API,
pointed at whichever running server the reader chooses.

It is the public, no-install twin of the `/docs` route a running host serves —
same six slices, same group names — with one difference in where the documents
come from. The host merges each slice's spec live, in-process; this page bundles
the **committed OpenAPI snapshots**:

| Sidebar group | Snapshot                                                                  |
| ------------- | ------------------------------------------------------------------------- |
| Gatekeeper    | `slices/gatekeeper/gatekeeper-rust/openapi/gatekeeper-oauth.openapi.json` |
| Apps          | `slices/apps/apps-rust/openapi/apps.openapi.json`                         |
| Databases     | `slices/databases/databases-rust/openapi/databases.openapi.json`          |
| Collector     | `slices/collector/collector-rust/openapi/collector.openapi.json`          |
| Tunnel        | `slices/tunnel/tunnel-rust/openapi/tunnel-admin.openapi.json`             |
| FHIR R4       | `slices/emr/emr-rust/openapi/fhir-r4.openapi.json`                        |

Those snapshots are the same files the per-slice Rust snapshot tests and the
`api-sync.yml` drift guard hold to the live routes, so publishing from them
needs no Rust toolchain in the Pages deploy and still cannot silently drift from
the server. See the
[OpenAPI Spec Drift How-To](../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md).

Nothing loads from a CDN: the Scalar reference comes from its npm package and
the specs are imported as modules, so the whole console is one self-contained
bundle.

## The `?server=` contract

The console is a static page, so the API it documents is never its own origin.
The target lives in the URL:

```text
/wildflower-server-docs                                        → http://127.0.0.1:8080
/wildflower-server-docs?server=https://example-tunnel-origin   → that origin
```

- Only absolute `http:` / `https:` URLs are accepted. Anything else —
  `javascript:`, `data:`, protocol-relative `//host`, a bare hostname — is
  rejected, and the console falls back to the default.
- The default is the loopback origin the desktop host's embedded server binds —
  `http://127.0.0.1:8080` today. It is **derived** from
  `apps/wildflower-tauri/tauri-shared-config.json` (the same file the Rust host
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

The parsing, the document transforms and the Scalar configuration are pure
functions in `src/server-target.ts`, `src/spec.ts` and `src/configuration.ts`,
unit-tested beside them; `src/main.ts` is the DOM and history wiring.

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

1. **Discovery.** The `?server=` target is treated as the SMART `iss`: the
   console fetches `{server}/fhir-r4/.well-known/smart-configuration` and reads
   `authorization_endpoint` and `token_endpoint` out of it. Nothing about the
   server's URL layout is assumed — a Wildflower server answers that path from
   `slices/emr/emr-rust/src/smart_configuration.rs` (unauthenticated, exempt
   from the bearer gate) and points it at its own gatekeeper. A target that
   answers with something else, or not at all, fails here and the reason is
   shown in the header bar.
2. **Authorization.** The console redirects to the `authorization_endpoint` as
   the public PKCE client `wildflower-server-docs` — S256 challenge, random
   `state`, `aud={server}/fhir-r4`, and the whole scope set the client is
   allowed to request. The Owner approves (or narrows) it on the server's own
   consent page; `allowed_scopes` is only the ceiling, so the grant is whatever
   they agree to.
3. **Redemption.** The server sends the browser back with `code` + `state`, the
   console checks the `state` against what it stashed, redeems the code at the
   `token_endpoint` with the PKCE verifier (no client secret — a static page
   keeps none), and prefills every source's bearer field with the access token.
   The `code` and `state` are stripped from the address bar immediately.

The client is registered by
`slices/gatekeeper/gatekeeper-rust/migrations/0007_seed_wildflower_server_docs_client`;
`src/smart-client.ts` is the browser-side reading of that row, and must match it.

Scalar's own OAuth2 support is deliberately **not** used. It authorizes
per-document, so a six-slice console would ask the reader to sign in six times;
it drives the flow through a popup whose location it polls, which would boot a
second copy of this bundle inside the popup; and it generates `state` with
`Math.random`. The flow above is ~200 lines of dependency-free code in
`smart-discovery.ts`, `pkce.ts`, `authorization-flow.ts` and `sign-in.ts`, all
unit-tested, and it puts one token into all six documents through Scalar's
`authentication` configuration block.

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

### Sign-in only works on the published console

The seeded client registers exactly one redirect URI —
`https://wildflower-health.io/wildflower-server-docs/` — and `/oauth/authorize`
matches it by exact string equality. A copy served from anywhere else (`vp run
-F wildflower-server-docs dev`, a preview build, a fork's Pages site) therefore
cannot complete the flow, so the button is disabled there with the reason on the
status line. Everything else about the console works; paste a token into a
request's `Authorization` field instead.

Because that redirect URI carries no query string, `?server=` cannot ride back
in the URL: it travels in the stashed pending record and is restored when the
console returns.

## The CORS caveat

Requests are sent **straight from the reader's browser** to the chosen server —
there is no proxy — so they are cross-origin and subject to the browser's rules:

- The Wildflower API applies `CorsLayer::very_permissive()` across its whole
  surface (`apps/wildflower-tauri/src-tauri/src/lib.rs`), which mirrors the
  requesting origin back rather than sending `*`, so the `Authorization` header
  is allowed and a cross-origin call from this page is accepted by the server.
- Targeting a **loopback** server from the HTTPS-published console is
  mixed content. Chromium and Safari treat `http://127.0.0.1` as a
  potentially-trustworthy origin and allow it; other browsers may block it. When
  a request fails with no response at all, that is the likely cause — run the
  console from `vp run -F wildflower-server-docs dev` (an `http://localhost`
  origin) or point it at the server's public tunnel origin instead.
- The server also gates on a loopback peer address: a forwarded request only
  passes through the tunnel relay. Pointing this console at a device's loopback
  from another machine cannot work, whatever CORS says.

## Development

```bash
vp run -F wildflower-server-docs dev     # local dev server
vp run -F wildflower-server-docs build   # bundle into dist/
vp test                                  # unit tests for the parsing/transforms
```

`apps/github-pages` copies `dist/` to `/wildflower-server-docs` in the published
artifact; the build uses a relative `base` so the assets resolve from that
sub-path.
