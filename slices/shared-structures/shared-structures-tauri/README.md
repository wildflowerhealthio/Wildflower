# shared-structures-tauri

Shared bootstrap for Tauri webviews that load arbitrary (non-Tauri) pages.

## What this package does

- **`./top-bar` — `injectBrowserTopBar(options)`.** An in-page "browser chrome"
  bar (Back / Reload / current URL) injected at the top of an arbitrary page.
  Built for hostile pages: CSP-safe CSSOM styling, a `closed` shadow root, and a
  self-healing `MutationObserver`. Configurable so each context picks its
  controls:
  - the **browser-sniffer** bootstrap uses a `Close` button that ends sniffing;
  - the **sandboxed-webview** (apps launch) bootstrap uses a `Back` chevron
    (history-back, then close), a Reload button, and reserves the bar's height
    so it doesn't overlay the page.

- **`.` — `sandboxedWebViewBootstrapScript`.** The self-contained IIFE
  (`src/sandboxed-webview-entry.ts`, bundled by
  `scripts/build-tauri-bootstrap.mts`) that looks up `window.__TAURI__.event`
  and injects the bar wired to emit `CloseSandboxedWebView` on the multiplexed
  bridge channel. The Rust crate `shared-structures-tauri-rust` embeds the same
  bytes via `include_str!` and injects them with
  `WebviewWindowBuilder::initialization_script(...)`.

- **`./bridge` — wire literals** (`BRIDGE_EVENT`, `CLOSE_SANDBOXED_WEBVIEW_TAG`)
  shared between the bootstrap and its Rust host.

## Generated files

`src/tauri-bootstrap.generated.ts` (the string export) and
`dist/tauri-bootstrap.js` (the raw IIFE for `include_str!`) are **gitignored**
and produced by `scripts/build-tauri-bootstrap.mts`, which runs on every
`vp install` via the package's `prepare` script. Regenerate by hand with:

```bash
vp run generate-tauri-bootstrap
```
