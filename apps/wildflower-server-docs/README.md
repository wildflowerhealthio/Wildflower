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

The parsing, the document transforms and the Scalar configuration are pure
functions in `src/server-target.ts`, `src/spec.ts` and `src/configuration.ts`,
unit-tested beside them; `src/main.ts` is the DOM and history wiring.

The configuration also turns off two Scalar defaults that would otherwise reach
third parties: its `web` layout proxies "send" through `https://proxy.scalar.com`
unless `proxyUrl` is set (that would hand a reader's request, bearer token
included, to a service we don't run — and could never reach a loopback server),
and `withDefaultFonts` pulls webfonts from `fonts.scalar.com`. Both are asserted
in `configuration.test.ts`.

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
