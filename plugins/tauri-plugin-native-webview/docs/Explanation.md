# tauri-plugin-native-webview — Explanation

## What this is

A Tauri v2 plugin that presents an external URL in a **native, JavaScript-injectable
web view popup** with **native chrome**, instead of a Tauri `WebviewWindow` with
fake in-page chrome.

Today it is **iOS only** and runs **in parallel** with the existing
`WebviewWindow` sniffer path (`browser-sniffer-tauri-rust` /
`shared-structures-tauri-rust`'s `sandboxed_webview`). Desktop and Android are
untouched: `open` returns `UnsupportedPlatform` there, so callers keep falling
back to the `WebviewWindow` path.

## Why

The browser-sniffer slice opens external pages in a Tauri `WebviewWindow`, then:

- draws fake browser chrome in-page (`injectBrowserTopBar`), and
- relies on `withGlobalTauri: true`, which exposes the **entire**
  `window.__TAURI__` IPC surface to arbitrary third-party origins.

On iOS, `WKWebView` (which Tauri already uses under the hood) supports the two
things we actually need — `WKUserScript(.atDocumentStart)` injection on **any**
origin, and a **scoped** JS↔native bridge via `WKScriptMessageHandler` — while
letting us wrap it in a real `UINavigationController` toolbar. So we can drop
both the fake chrome and the `__TAURI__` exposure.

Note the constraint that forced `WKWebView` (not `SFSafariViewController`) and a
custom toolbar: `SFSafariViewController` / Custom Tabs / `ASWebAuthenticationSession`
**cannot inject JavaScript**. Injection on any domain is the whole point of the
sniffer, so the native in-app-browser components are out; we keep the same engine
Tauri already uses and draw native chrome ourselves.

## Shape

```text
plugins/tauri-plugin-native-webview/
├── Cargo.toml                 — `links`, tauri-plugin build dep
├── build.rs                   — COMMANDS=["open"], ios_path("ios"); no android (iOS-only)
├── permissions/default.toml   — default grant = allow-open
├── src/
│   ├── lib.rs                 — init(), NativeWebviewExt, plugin wiring
│   ├── commands.rs            — `open(url)` IPC command
│   ├── models.rs              — OpenRequest/OpenResponse (camelCase wire)
│   ├── error.rs               — Error (serializes to string)
│   ├── desktop.rs             — no-op backend (UnsupportedPlatform)
│   └── mobile.rs              — iOS: register Swift plugin + run_mobile_plugin; android: unsupported
└── ios/
    ├── Package.swift
    └── Sources/NativeWebviewPlugin.swift  — WKWebView + native toolbar + document-start injection
```

## Round trip (the thin slice this increment proves)

```text
[main webview]  invoke('plugin:native-webview|open', { url })
      │
      ▼
[Rust] commands::open → NativeWebviewExt::open → mobile::NativeWebview::open
      │  run_mobile_plugin("open", OpenRequest)
      ▼
[Swift] NativeWebviewPlugin.open
      │  present WKWebView in UINavigationController (Close + host title), .pageSheet
      │  WKUserScript(.atDocumentStart, forMainFrameOnly: false) injected on ANY origin
      ▼
[injected JS, in the external page]  posts { kind, url } via
      window.webkit.messageHandlers.nativeWebview.postMessage(...)
      │
      ▼
[Swift] WKScriptMessageHandler → trigger("message", { kind, url })
      │
      ▼
[main webview]  addPluginListener('native-webview', 'message', cb)
```

The injected script is a placeholder that only posts `injected` /
`domcontentloaded` / `load` pings — enough to prove document-start injection on
any origin and the JS→native→host round trip. A later increment swaps it for the
real sniffer body (`installSniffer`) and moves the sniffer's event transport off
`window.__TAURI__` onto this scoped bridge.

## Deliberately deferred (not in this increment)

- **Android** native popup (Kotlin) — Android keeps the `WebviewWindow` path.
- **Desktop** native popup — keeps the multi-window Tauri path (already has OS
  chrome); only the mobile-only `injectBrowserTopBar` needs gating later.
- **Sniffer migration** — replacing the injected placeholder with
  `installSniffer` and retiring `injectBrowserTopBar` / `__TAURI__` on iOS.
- **A typed guest-js package** — callers use `invoke` / `addPluginListener` from
  `@tauri-apps/api` directly for now.

## Building / verifying (important)

The native half cannot be built on Linux:

- **iOS**: requires macOS + Xcode. Adding this plugin to the host app requires
  regenerating the iOS project so the Swift package is linked —
  `cargo tauri ios init` (or the next `cargo tauri ios build`/`dev`) from
  `apps/wildflower-tauri`. The committed `gen/apple/{project.yml,Podfile}` are
  regenerated to include the plugin; do not hand-edit `project.pbxproj`.
- **Desktop `cargo check`**: requires the GTK/WebKit system libs
  (`webkit2gtk-4.1`, `gtk+-3.0`) that `tauri`'s Linux desktop target links.
  Without them every tauri crate in the workspace fails at the `gdk-sys` build
  script — not a code error.

The Rust models/error logic is covered by unit tests in `models.rs` (run once a
GTK-equipped environment or CI compiles the crate).
