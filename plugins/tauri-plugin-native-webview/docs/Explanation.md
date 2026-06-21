# tauri-plugin-native-webview — Explanation

## What this is

A Tauri v2 plugin that presents an external URL in a **native, JavaScript-injectable
web view popup** with **native chrome**, instead of a Tauri `WebviewWindow` with
fake in-page chrome.

It exposes one command — `open(url)` — with a trial backend per platform, all
running **in parallel** with the existing `WebviewWindow` sniffer path
(`browser-sniffer-tauri-rust` / `shared-structures-tauri-rust`'s
`sandboxed_webview`), which stays in place:

| Platform | Backend | Native chrome | JS injection (any origin) | Bridge back to host |
| --- | --- | --- | --- | --- |
| iOS | Swift `WKWebView` in `UINavigationController` (`.pageSheet`) | Close + host title | `WKUserScript(.atDocumentStart)` | `WKScriptMessageHandler` → `trigger` |
| Android | Kotlin `android.webkit.WebView` in a fullscreen `Dialog` | `Toolbar` Close + host | `WebViewCompat.addDocumentStartJavaScript(…, setOf("*"))` | `@JavascriptInterface` → `trigger` |
| Desktop | Tauri `WebviewWindow` | OS window frame | `initialization_script` | event bus (`native-webview:message`) |

## Why

The browser-sniffer slice opens external pages in a Tauri `WebviewWindow`, then:

- draws fake browser chrome in-page (`injectBrowserTopBar`), and
- relies on `withGlobalTauri: true`, which exposes the **entire**
  `window.__TAURI__` IPC surface to arbitrary third-party origins.

On **mobile**, `WKWebView` / `android.webkit.WebView` (the same engines Tauri
uses under the hood) support the two things we actually need —
at-document-start injection on **any** origin, and a **scoped** JS↔native bridge
— while letting us wrap them in a real native toolbar. So we drop both the fake
chrome and the `__TAURI__` exposure.

The constraint that forced `WKWebView` / `WebView` (not `SFSafariViewController` /
Chrome Custom Tabs / `ASWebAuthenticationSession`): those native in-app-browser
components **cannot inject JavaScript**. Injection on any domain is the whole
point of the sniffer, so we keep the same engine Tauri already uses and draw
native chrome ourselves.

## Desktop is different on purpose

A *non-Tauri* native web view on desktop (raw `WKWebView` via objc2, `WebView2`
via the windows crate) would require `unsafe` FFI, which this workspace forbids
(`unsafe_code = "forbid"`). So the desktop trial presents Tauri's own
`WebviewWindow` — still a real OS window with a native webview (WKWebView on
macOS, WebView2 on Windows, webkit2gtk on Linux) and native window chrome — with
document-start injection via `initialization_script`.

The trade-off: a `WebviewWindow` is a Tauri webview, so `window.__TAURI__` is
present in the loaded page. It is scoped by
`apps/wildflower-tauri/src-tauri/capabilities/native-webview-window.json` to the
event bus only (mirroring the browser-sniffer posture). The mobile backends
avoid that exposure entirely. Desktop already had native window chrome anyway, so
the bigger desktop win remains gating `injectBrowserTopBar` to mobile (a later
change).

## Shape

```text
plugins/tauri-plugin-native-webview/
├── Cargo.toml                 — links, tauri-plugin build dep, url (desktop)
├── build.rs                   — COMMANDS=["open"], ios_path + android_path
├── permissions/default.toml   — default grant = allow-open
├── src/
│   ├── lib.rs                 — init(), NativeWebviewExt, plugin wiring
│   ├── commands.rs            — open(url) IPC command
│   ├── models.rs              — OpenRequest/OpenResponse (camelCase wire) + tests
│   ├── error.rs               — Error (PluginInvoke on mobile / Internal on desktop)
│   ├── desktop.rs             — WebviewWindow popup + initialization_script
│   └── mobile.rs              — registers the Swift (iOS) / Kotlin (Android) plugin
├── ios/
│   ├── Package.swift
│   └── Sources/NativeWebviewPlugin.swift
└── android/
    ├── build.gradle.kts · settings.gradle · proguard-rules.pro · .gitignore
    └── src/main/
        ├── AndroidManifest.xml
        └── java/com/plugin/nativewebview/NativeWebviewPlugin.kt
```

## Round trip (what the thin slice proves)

```text
[main webview]  invoke('plugin:native-webview|open', { url })
      │
      ▼
[Rust] commands::open → NativeWebviewExt::open → platform backend
      │
      ├─ iOS/Android: run_mobile_plugin("open", { url, initScript })
      │     → present native WebView (native chrome)
      │     → caller's initScript injected at document start on ANY origin
      │     → page posts an opaque JSON string over the scoped native bridge
      │       (window.webkit.messageHandlers.nativeWebview / window.nativeWebview)
      │     → native trigger("message", { payload }) → addPluginListener on host
      │
      └─ Desktop: WebviewWindowBuilder(...).initialization_script(initScript)
            → present WebviewWindow (OS chrome)
            → caller's initScript injected at document start
            → (the page is a Tauri webview, so the script uses the event bus
              directly — no native message bridge needed)
```

`initScript` is **caller-supplied** — the plugin is content-agnostic. browser-sniffer
passes its bundled `installSniffer` IIFE wrapped in a small adapter that speaks
the platform bridge (mobile: post a JSON string to `nativeWebview`; desktop: the
existing `__TAURI__.event` transport). The mobile message payload is an opaque
JSON string so the bridge needn't know the sniffer's schema.

## Deliberately deferred

- **Inbound host→native messages** — the bridge is outbound-only today (page →
  host). The sniffer's Host→Web messages (`Click`, `CancelSnifferRequest`) need
  a path the other way: the plugin listening on the bridge channel and calling
  `evaluateJavaScript` / `evaluateJavascript` into the native webview.
- **browser-sniffer native transport + entry** — the adapter that wraps the
  platform bridge into the `TauriEventApi` shape `installSniffer` expects, a
  `native-sniffer-entry` that drops `injectBrowserTopBar` (native chrome
  replaces it), and the build step that bundles it for the `initScript` arg.
- **Host wiring** — routing `RequestSniffableWebView` to `open(...)` on mobile,
  and re-emitting the native `message` payloads onto the `bridge` event bus so
  the existing collector consumer is unchanged.
- **A typed guest-js package** — callers use `invoke` / `addPluginListener` /
  `listen` from `@tauri-apps/api` directly for now.
- **Desktop**: a structured error/result channel back from the popup (the build
  is currently dispatched to the main thread and logged best-effort), and an
  open/close race sentinel like `sandboxed_webview`'s.

## Building / verifying (important)

The native halves cannot be built on Linux:

- **iOS**: macOS + Xcode. Linking requires regenerating the iOS project so the
  Swift package is picked up — `cargo tauri ios init` (or the next
  `ios build`/`dev`) from `apps/wildflower-tauri`. Do not hand-edit
  `project.pbxproj`.
- **Android**: the Android SDK + Gradle. Linking requires regenerating the
  Android project (`cargo tauri android init`/`build`) so the Kotlin library is
  included. `WebViewCompat.addDocumentStartJavaScript` also needs a WebView
  provider that supports `DOCUMENT_START_SCRIPT` (modern Android System WebView);
  the code falls back to `onPageStarted` injection otherwise.
- **Desktop `cargo check`**: needs the GTK/WebKit system libs
  (`webkit2gtk-4.1`, `gtk+-3.0`) the Linux desktop target links. Without them
  every tauri crate fails at the `gdk-sys` build script — not a code error.

The Rust models/error logic is covered by unit tests in `models.rs` (run once a
GTK-equipped environment or CI compiles the crate).
