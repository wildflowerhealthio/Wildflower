# Tauri Host Explanation

How `browser-sniffer-tauri-rust` (Rust) and `browser-sniffer-tauri` (TS) work together to run the sniffer inside a native webview presented by [`tauri-plugin-native-webview`](../../../plugins/tauri-plugin-native-webview/docs/Explanation.md) — on iOS, Android, and desktop alike.

## What the crate is

A pure event-bus router. The Rust side listens on the multiplexed `BRIDGE_EVENT` channel for SPA-emitted `CollectorBridge.webToHost` tags and translates them into native-webview lifecycle operations against the plugin:

| Tag                              | Effect                                                                                                                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RequestSniffableWebView`        | Present the sniffer's native webview via `native_webview().open(...)`. A second tag while it is up is replayed onto the existing native webview (channel + initScript + chrome + URL rebound in place — see "Re-wire" below).                |
| `Open`                           | Same as `RequestSniffableWebView` plus URL-source resolution.                                                                                                                                                                                |
| `SniffingComplete`               | Close the native webview via `native_webview().close(true)` (`suppress_close_event`), so the plugin skips the `NativeWebviewEvent::Closed` echo that would otherwise re-emit a second `SniffingComplete` onto the bridge.                    |
| `Click` / `CancelSnifferRequest` | **Mobile only**: forwarded into the native webview via `native_webview().evaluate_js(...)`. Desktop's native-webview content webview is still a Tauri webview (`__TAURI__.event.listen`) and receives Rust `app.emit('bridge', …)` directly. |

No Rust-side forwarding for the data plane. Sniffer-emitted `bridge:ResponseStart` / `ResponseData` / `PageLoaded` / etc. flow back over either:

- **Mobile**: the native webview's native bridge (`webkit.messageHandlers.nativeWebview` / `window.nativeWebview`) into the plugin's per-native-webview `NativeWebviewMessageBridge` → `Channel<NativeWebviewEvent>` → `native_webview_bridge::dispatch_body` → `app.emit(BRIDGE_EVENT, inner_payload)`.
- **Desktop**: the native webview's `__TAURI__.event.emit('bridge', …)` directly — main webview's `makeTauriTransport` listens on the same channel, and Tauri broadcasts to every webview AND to the Rust side.

`CollectorBridge` re-exports `BrowserSnifferBridge`'s webToHost schemas as its own hostToWeb messages, so tag names line up across the multiplexed channel either way.

## Why the plugin and not `WebviewWindow`

The sniffer used to present the external URL in a Tauri `WebviewWindow`, drawing fake browser chrome in-page (`injectBrowserTopBar`) and exposing the **entire** `window.__TAURI__` IPC surface to whichever third-party origin loaded. The `tauri-plugin-native-webview` plugin replaces that:

- **iOS**: real `WKWebView` in a `UINavigationController` (`.pageSheet`), native chrome (Close + page host + back/forward), document-start injection via `WKUserScript(.atDocumentStart, forMainFrameOnly: false)`, scoped JS↔native bridge through `WKScriptMessageHandler`. No `__TAURI__` exposure to the loaded page at all.
- **Android**: `android.webkit.WebView` in a fullscreen `Dialog` + `Toolbar`, document-start injection via `WebViewCompat.addDocumentStartJavaScript(..., setOf("*"))`, scoped bridge via `@JavascriptInterface`. No `__TAURI__` exposure.
- **Desktop**: a Tauri parent `Window` with two child webviews via `Window::add_child` — a chrome bar on top and the external URL underneath. The content webview is still a Tauri webview (so `__TAURI__` is present), scoped by `apps/wildflower-tauri/src-tauri/capabilities/native-webview-window.json` to the event bus only — matching the pre-plugin posture.

The constraint that forced `WKWebView` / `WebView` (not `SFSafariViewController` / Chrome Custom Tabs): those in-app-browser components **cannot inject JavaScript**. Injection on any domain is the whole point of the sniffer.

## Two bootstrap variants

The TS side ships two self-contained IIFEs and the Rust crate `include_str!`s the bytes of whichever variant matches the target:

- `native-bootstrap.js` — used on iOS/Android. Builds a `TauriEventApi`-shaped event bus over the plugin's native bridge (`window.webkit.messageHandlers.nativeWebview` / `window.nativeWebview`) via `makeNativeBridgeEventBus`. No `__TAURI__` access.
- `tauri-bootstrap.js` — used on desktop. Reads `globalThis.__TAURI__.event` directly. The content webview is a Tauri webview, so this works without any bridge.

Both variants call `installSniffer(event)`, which wires fetch / XHR / console shims and registers a single `event.listen(BRIDGE_EVENT, …)` that demuxes inbound `Click` / `CancelSnifferRequest` by the payload's `_tag`. **No in-page `BrowserTopBar`** — the plugin draws native chrome on all three platforms, so the in-page bar is gone for good.

If neither transport is present (e.g. the page is opened outside a native webview), both bootstraps no-op end-to-end: no shims attach, no listeners register.

## Close-then-reopen ("switch demos") race

A SniffingComplete-followed-by-RequestSniffableWebView arrives as two sequential bridge events on the same main-thread listener tick. The plugin's `close()` on desktop only **queues** the OS-level close via `proxy.send_event(Message::Window(..., Close))` (see `tauri-runtime-wry`'s `WindowDispatcher::close` — explicitly NOT via `send_user_message`, "because it accesses the event loop callback"), so the same-tick reopen runs **before** the close is processed.

The plugin handles this internally via a **cancelable close**: `close()` flips an app-managed `closing` flag before asking the runtime to close, the same-tick `present()` stashes its `OpenRequest` into `pending_reopen` instead of navigating the doomed window, and the window's `CloseRequested` handler reads `pending_reopen` to either:

- **`Some(payload)`** → `api.prevent_close()` and rewire the live webviews against the new request (channel, initScript, chrome, URL). The native webview never visually closes; the user sees a navigation.
- **`None`** → let the close proceed normally; `Destroyed` fires, the native webview goes away.

iOS/Android use the analogous deferred-replay pattern: a same-tick reopen during the dismiss animation queues a closure into `pendingOpenAfterClose`, the dismiss listener consumes it instead of emitting `Closed`, and presents fresh.

The sniffer no longer tracks close initiation itself. `sniffing_complete::handle` calls `native_webview().close(true)` (`suppress_close_event`), so the plugin skips the `NativeWebviewEvent::Closed` echo for that host-initiated close (and the prevent-close + rewire path never fires `Closed` at all). A user / OS dismissal goes through `close` without suppression and still emits `NativeWebviewEvent::Closed`, which `native_webview_bridge::dispatch_body` turns into `SniffingComplete` so the collector releases per-native-webview state.

## Re-wire on a stacked second `open()`

The plugin's `open()` is idempotent: a second call while a native webview is up does NOT stack a new one. Instead it rebinds the existing native webview's `Channel<NativeWebviewEvent>`, re-injects the new `initScript`, re-applies caller-supplied initial chrome, and navigates the content webview to the new URL.

**InitScript caveat**: the original script was wired into the webview's document-start hook at build time, and platform APIs don't let us swap that hook after build. On rewire, the new script lands via `eval` — typically AFTER the page's own document-start scripts on the navigating page, not before. iOS and Android also add the new script to the user content controller for **future** loads inside this native webview (those will be document-start), but the immediate navigation that triggered the rewire is best-effort. The sniffer's bundle is stable across opens so the difference is invisible to it; callers that rely on document-start semantics across stacked opens should be aware.

## Initial chrome at presentation time

The sniffer passes `initial_subtitle: "Collecting Automatically"` to `open()` so the native webview's first paint already shows the sniffer status — vs. a post-open `patch_window_text` call that would race the chrome bar's build on desktop (the chrome webview isn't ready until after `add_child` resolves). Title defaults to the URL host on every fresh build; `message` is reserved for future per-request counters.

## Crate layout

```text
browser-sniffer-tauri-rust/
├── src/
│   ├── lib.rs                       — public surface + `attach_browser_sniffer` glue
│   ├── events.rs                    — event-name constants (drift guard against the TS side)
│   ├── bootstrap.rs                 — `include_str!` of the per-target TS-generated IIFE
│   ├── sniffer_window.rs            — `open_or_navigate` (plugin call site)
│   ├── native_webview_bridge.rs     — `NativeWebviewChannel` + `Channel<NativeWebviewEvent>` handler + mobile `evaluate_js` forwarder
│   ├── model/
│   │   ├── request_sniffable_webview.rs — `RequestSniffableWebViewPayload`
│   │   ├── open.rs                  — `OpenPayload`
│   │   └── web_view_source.rs       — `WebViewSourcePayload`, `resolve_source`, `SourceResolveError`
│   └── handlers/
│       ├── request_sniffable_webview.rs
│       ├── open.rs
│       └── sniffing_complete.rs
└── Cargo.toml
```

Doc-comments at the top of each file should be quick references useful on hover. The full prose lives here.

## Key file references

- [`browser-sniffer-tauri-rust/src/lib.rs`](../browser-sniffer-tauri-rust/src/lib.rs) — entry point; wires the single bridge listener.
- [`browser-sniffer-tauri-rust/src/sniffer_window.rs`](../browser-sniffer-tauri-rust/src/sniffer_window.rs) — the only file that calls `native_webview().open(...)`.
- [`browser-sniffer-tauri-rust/src/native_webview_bridge.rs`](../browser-sniffer-tauri-rust/src/native_webview_bridge.rs) — channel handler: validates inbound native-webview messages and translates `NativeWebviewEvent::Closed` into `SniffingComplete`.
- [`browser-sniffer-tauri/src/install-sniffer.ts`](../browser-sniffer-tauri/src/install-sniffer.ts) — fetch / XHR / console shim emitting on `BRIDGE_EVENT` via `eventBus.emit`.
- [`browser-sniffer-tauri/src/native-bridge.ts`](../browser-sniffer-tauri/src/native-bridge.ts) — `makeNativeBridgeEventBus`, the `TauriEventApi`-shaped bus over the plugin's native bridge.
- [`browser-sniffer-tauri/src/tauri-sniffer-entry.ts`](../browser-sniffer-tauri/src/tauri-sniffer-entry.ts) — desktop IIFE wrapper.
- [`browser-sniffer-tauri/src/native-sniffer-entry.ts`](../browser-sniffer-tauri/src/native-sniffer-entry.ts) — mobile IIFE wrapper.
- [`slices/collector/collector-fundamentals/src/bridge.ts`](../../collector/collector-fundamentals/src/bridge.ts) — consumer-side bridge schema; the Rust payload structs in `model/{request_sniffable_webview,open}.rs` mirror its shapes.
- [`plugins/tauri-plugin-native-webview/docs/Explanation.md`](../../../plugins/tauri-plugin-native-webview/docs/Explanation.md) — plugin's own architecture write-up.
