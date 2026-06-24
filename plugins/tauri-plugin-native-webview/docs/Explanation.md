# tauri-plugin-native-webview — Explanation

## What this is

A Tauri v2 plugin that presents an external URL in a **native, JavaScript-injectable
web view popup** with **native chrome**, instead of a Tauri `WebviewWindow` with
fake in-page chrome.

It exposes four commands, with a backend per platform:

- `open(url, initScript, nativeWebviewEventChannel, initialTitle?, initialSubtitle?, initialMessage?)` — present the popup.
- `evaluate_js(script)` — evaluate JS inside the open popup.
- `patch_window_text({title?, subtitle?, message?})` — update one or more of the chrome's title/subtitle/message labels.
- `close(suppress_close_event = false)` — dismiss the popup. Emits `NativeWebviewEvent::Closed` on the channel for the dismissal, unless `suppress_close_event` is `true` (a host that already observed the terminal event prompting the close passes `true` so the echo doesn't double-fire). User / OS dismissals always emit.

| Platform | Backend                                                           | Native chrome                                                          | JS injection (any origin)                                 | Bridge back to host                                      |
| -------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| iOS      | Swift `WKWebView` in `UINavigationController` (`.pageSheet`)      | Close + host title                                                     | `WKUserScript(.atDocumentStart)`                          | `WKScriptMessageHandler` → `Channel<NativeWebviewEvent>` |
| Android  | Kotlin `android.webkit.WebView` in a fullscreen `Dialog`          | `Toolbar` Close + host                                                 | `WebViewCompat.addDocumentStartJavaScript(…, setOf("*"))` | `@JavascriptInterface` → `Channel<NativeWebviewEvent>`   |
| Desktop  | Tauri parent `Window` + two child webviews (chrome bar + content) | Plugin-drawn chrome bar (host/subtitle/message + back/forward/refresh) | `initialization_script` on the content child              | event bus (page uses `__TAURI__.event` directly)         |

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

A _non-Tauri_ native web view on desktop (raw `WKWebView` via objc2, `WebView2`
via the windows crate) would require `unsafe` FFI, which this workspace forbids
(`unsafe_code = "forbid"`). So the desktop backend uses Tauri's own webviews —
still real native webviews (WKWebView on macOS, WebView2 on Windows, webkit2gtk
on Linux) — with document-start injection via `initialization_script`.

To mirror the mobile popups' native chrome, the desktop backend builds a parent
`Window` (label `native-webview`) with **two child webviews** (via Tauri's
`unstable` multi-webview-per-window API): a `data:`-HTML **chrome bar** child
(`native-webview-chrome`) anchored at the top — drawing the host/subtitle/message
labels plus back/forward/refresh — and the external **content** child
(`native-webview-content`) below it. The plugin draws this chrome itself; it is
not the OS window frame. Chrome → Rust IPC rides a custom-scheme `on_navigation`
intercept (no `__TAURI__` commands), and Rust → chrome state push uses
`Webview::eval`; see the `desktop.rs` module docs.

The trade-off: the content child is a Tauri webview, so `window.__TAURI__` is
present in the loaded page. It is scoped by
`apps/wildflower-tauri/src-tauri/capabilities/native-webview-window.json` to the
event bus only (mirroring the browser-sniffer posture). The chrome child needs
no capability — it issues no Tauri commands. The mobile backends avoid the
`__TAURI__` exposure entirely.

## Shape

```text
plugins/tauri-plugin-native-webview/
├── Cargo.toml                 — links, tauri-plugin build dep, url (desktop)
├── build.rs                   — COMMANDS=["open","evaluate_js","patch_window_text","close"], ios_path + android_path
├── permissions/default.toml   — default grant = open + evaluate-js + patch-window-text + close (hand-authored per-command grants)
├── src/
│   ├── lib.rs                 — init(), NativeWebviewExt, plugin wiring
│   ├── commands.rs            — open / evaluate_js / patch_window_text / close IPC commands
│   ├── models.rs              — OpenRequest/OpenResponse, EvaluateJsRequest/EvaluateJsResponse, PatchWindowTextRequest/PatchWindowTextResponse, NativeWebviewEvent + tests
│   ├── error.rs               — Error (PluginInvoke on mobile / Internal on desktop)
│   ├── url_scheme.rs          — http(s)-only URL parse/validate, shared by both backends
│   ├── desktop.rs             — parent Window + chrome/content child webviews, initialization_script on content, eval for evaluate_js/patch_window_text
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

## Round trip

```text
[caller (Rust or JS)]  open(url, initScript, nativeWebviewEventChannel: Channel<NativeWebviewEvent>)
      │
      ▼
[Rust] commands::open → NativeWebviewExt::open → platform backend
      │
      ├─ iOS/Android: run_mobile_plugin("open", { url, initScript, nativeWebviewEventChannel })
      │     → present native WebView (native chrome)
      │     → caller's initScript injected at document start on ANY origin
      │     → page posts an opaque JSON string over the scoped native bridge
      │       (window.webkit.messageHandlers.nativeWebview / window.nativeWebview)
      │     → Swift/Kotlin channel.send({ event:"message", payload }) → Rust
      │       channel handler fires (caller-owned, no JS bridging)
      │     → user dismiss via native chrome → channel.send({ event:"closed" })
      │
      └─ Desktop: parent Window + chrome/content child webviews; the content
            child gets initScript via initialization_script
            → present the popup with a plugin-drawn chrome bar
            → caller's initScript injected at document start on the content child
            → (the content page is a Tauri webview, so the script uses the event
              bus directly — channel goes unused on desktop today)

[caller]  evaluate_js(script)  // evaluateJavaScript into the popup webview
      │
      ▼
[Rust] commands::evaluate_js → NativeWebviewExt::evaluate_js → platform backend
      │
      ├─ iOS/Android: WKWebView.evaluateJavaScript / WebView.evaluateJavascript
      └─ Desktop:     content child webview eval (looked up by CONTENT_WEBVIEW_LABEL)
```

`initScript` is **caller-supplied** — the plugin is content-agnostic. browser-sniffer
passes its bundled `installSniffer` IIFE wrapped in a small adapter that posts
to the platform bridge; `browser-sniffer-tauri-rust::popup_bridge` owns the
`Channel<NativeWebviewEvent>` and re-emits onto its `BRIDGE_EVENT` bus.

`evaluate_js` is the reverse direction — `browser-sniffer-tauri-rust` calls it on
mobile when it sees `Click` / `CancelSnifferRequest` on `BRIDGE_EVENT`, wrapping
the payload in a `window.__nativeWebviewReceive(...)` call the popup-side
transport parses. JS host code never touches the plugin.

## Why a Channel (not `trigger` + `addPluginListener`)

Earlier drafts had Swift/Kotlin call `trigger("message", …)` and the host JS
subscribe via `addPluginListener('native-webview', 'message', …)`. That works
but pins the bridging to the JS layer — every transport swap (e.g. a future
HTTP transport for the collector) would have to re-route the JS half.

`Channel<NativeWebviewEvent>` from `tauri::ipc` keeps the wire native→Rust. The caller
(Rust) creates the channel with a Rust closure handler; the channel handle
serialises as `"__CHANNEL__:<id>"` into the `open` invoke payload; Swift's
`Channel: Decodable` / Kotlin's `ChannelDeserializer` re-wires it on the native
side; `channel.send(...)` from native flows back through the `sendChannelData`
callback into the Rust closure. No JS detour, transport-agnostic.

## Deliberately deferred

- **A typed guest-js package** — callers use `invoke` from `@tauri-apps/api`
  directly. Rust callers go through `NativeWebviewExt` / `OpenRequest` /
  `EvaluateJsRequest`.

(The desktop open/close race sentinel and the `NativeWebviewEvent::Closed`-on-dismiss
emission that earlier drafts deferred are now implemented — see `PluginState`
and the `Destroyed` handler in `desktop.rs`. `open()` also propagates build
errors back to the caller synchronously via a `sync_channel`, rather than
logging best-effort.)

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
