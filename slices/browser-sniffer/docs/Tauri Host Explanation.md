# Tauri Host Explanation

How `browser-sniffer-tauri-rust` (Rust) and `browser-sniffer-tauri` (TS) work together to run the sniffer inside a native webview presented by [`tauri-plugin-native-webview`](../../../plugins/tauri-plugin-native-webview/docs/Explanation.md) — on iOS, Android, and desktop alike.

## What the crate is

A pure event-bus router. The Rust side listens on the multiplexed `BRIDGE_EVENT` channel for SPA-emitted `CollectorBridge.webToHost` tags and translates them into native-webview lifecycle operations against the plugin:

| Tag                                   | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RequestSniffableWebView`             | Present the sniffer's native webview: `native_webview().open_url(...)` (navigate, building hidden if absent) then `native_webview().show()`. A second tag while it is up rebinds the existing native webview in place (channel + initScript + chrome + URL — see "Re-wire" below).                                                                                                                                                                 |
| `Open`                                | Decode the `Open` payload, resolve its `WebViewSource`, then `open_or_navigate` — identical in effect to `RequestSniffableWebView` (both resolve the source; the native webview is opened fresh if absent, else navigated in place). Distinct tag/payload so the SPA can drive a navigation independently of the initial present.                                                                                                                  |
| `SniffingComplete`                    | Dispose the native webview via `native_webview().dispose()` — the sniff is done, so its background runtime is torn down and resources freed. `SniffingComplete` is SPA-driven and terminal; the host doesn't re-emit it.                                                                                                                                                                                                                           |
| `SetSnifferStatus`                    | Decode the `{ name }` payload and write it to the sniffer chrome **subtitle** via `native_webview().patch_window_text(...)` — the collector's per-step label ("Entering email", "Waiting for prescriptions to load"). Host-consumed on **every** platform (like `Open` / `SniffingComplete`), never forwarded into the page; a decode failure or missing webview is warned-and-dropped.                                                            |
| `EnsureSnifferVisible`                | (Re-)present the existing native webview via `native_webview().show(...)` — the collector's fire-and-advance `EnsureWindowVisible` step. Payload-less. Unlike `Open` it does **not** navigate: it reveals a hidden-but-alive webview without reloading. Idempotent, and a no-op when no webview exists — `show` can't distinguish "absent" from "already visible", so nothing is reported back and the SPA never learns whether a window appeared. |
| `PageAction` / `CancelSnifferRequest` | **Mobile only**: forwarded into the native webview via `native_webview().evaluate_js(...)`. Desktop's native-webview content webview is still a Tauri webview (`__TAURI__.event.listen`) and receives Rust `app.emit('bridge', …)` directly. `PageAction` carries the scripted interaction (`Click` / `Fill`, demuxed page-side by `action.kind`); the host forwards it by `_tag` without decoding.                                                |

The data plane is host-mediated on **both** platforms: the content webview loads untrusted third-party content, so its web→host `bridge:ResponseStart` / `ResponseData` / `PageLoaded` / etc. never reach `BRIDGE_EVENT` straight from the page — the host allowlists the inner `_tag` (the data-plane set, excluding control tags) and re-broadcasts. Two transports, one gate:

- **Mobile**: the native webview's native bridge (`webkit.messageHandlers.nativeWebview` / `window.nativeWebview`) into the plugin's per-native-webview `NativeWebviewMessageBridge` → `Channel<NativeWebviewEvent>` → `native_webview_bridge::dispatch_body` → `validate_native_webview_message` (allowlist) → `app.emit(BRIDGE_EVENT, inner_payload)`.
- **Desktop**: the content webview is a Tauri webview but its capability withholds the bus `emit` grant, so its data plane rides the `native_webview_data_plane_emit` command → `data_plane_value_is_allowed` (the same allowlist) → `app.emit(BRIDGE_EVENT, payload)`. The main SPA webview's `makeTauriTransport` listens on the channel, and Tauri broadcasts the host re-emit to every webview AND the Rust side. See "Why the content webview can't emit control tags" below.

`CollectorBridge` re-exports `BrowserSnifferBridge`'s webToHost schemas as its own hostToWeb messages, so tag names line up across the multiplexed channel either way.

## Why the plugin and not `WebviewWindow`

The sniffer used to present the external URL in a Tauri `WebviewWindow`, drawing fake browser chrome in-page (`injectBrowserTopBar`) and exposing the **entire** `window.__TAURI__` IPC surface to whichever third-party origin loaded. The `tauri-plugin-native-webview` plugin replaces that:

- **iOS**: real `WKWebView` in a `UINavigationController` (`.pageSheet`), native chrome (Close + page host + back/forward), document-start injection via `WKUserScript(.atDocumentStart, forMainFrameOnly: false)`, scoped JS↔native bridge through `WKScriptMessageHandler`. No `__TAURI__` exposure to the loaded page at all.
- **Android**: `android.webkit.WebView` in a fullscreen `Dialog` + `Toolbar`, document-start injection via `WebViewCompat.addDocumentStartJavaScript(..., setOf("*"))`, scoped bridge via `@JavascriptInterface`. No `__TAURI__` exposure.
- **Desktop**: a Tauri parent `Window` with two child webviews via `Window::add_child` — a chrome bar on top and the external URL underneath. The content webview is still a Tauri webview (so `__TAURI__` is present), scoped by `apps/wildflower-tauri/src-tauri/capabilities/native-webview-window.json` to event-bus `listen` (inbound `PageAction` / `CancelSnifferRequest`) plus the gated `native_webview_data_plane_emit` command — see below.

The constraint that forced `WKWebView` / `WebView` (not `SFSafariViewController` / Chrome Custom Tabs): those in-app-browser components **cannot inject JavaScript**. Injection on any domain is the whole point of the sniffer.

### Why the content webview can't emit control tags

`withGlobalTauri: true` injects `__TAURI__` into every webview, including the content webview loading an arbitrary third-party page. Tauri's event ACL has no per-event-name scope, so a `core:event:allow-emit` grant is all-or-nothing: a page with it could call `__TAURI__.event.emit('bridge', {_tag:'SniffingComplete'})` and the host's `BRIDGE_EVENT` router would honor it — disposing the sniffer mid-capture, or steering it via `Open` / `RequestSniffableWebView`. Control tags are legitimately emitted only by the **trusted main SPA**, never the content webview.

So the split is enforced at the transport/capability layer, not by event name (which can't separate them — both ride `BRIDGE_EVENT`):

- The content webview's capability grants `core:event:allow-listen` + `allow-unlisten` (inbound only), **not** `allow-emit` / `allow-emit-to`.
- Its data plane goes through `native_webview_data_plane_emit`, which allowlists the inner `_tag` to the data-plane set before re-broadcasting — so the page can reach data tags and nothing else.
- The trusted main SPA keeps its `core:event:default` grant and emits control tags on `BRIDGE_EVENT` as before.

This makes desktop match the mobile posture, where the page never had `__TAURI__` and its data plane was always gated through `validate_native_webview_message`.

## Two bootstrap variants

The TS side ships two self-contained IIFEs and the Rust crate `include_str!`s the bytes of whichever variant matches the target:

- `native-bootstrap.js` — used on iOS/Android. Builds a `TauriEventApi`-shaped event bus over the plugin's native bridge (`window.webkit.messageHandlers.nativeWebview` / `window.nativeWebview`) via `makeNativeBridgeEventBus`. No `__TAURI__` access.
- `tauri-bootstrap.js` — used on desktop. Listens on `globalThis.__TAURI__.event` for inbound tags but routes outbound emits through the `globalThis.__TAURI__.core.invoke('native_webview_data_plane_emit', …)` command (the content webview holds no bus `emit` grant — see "Why the content webview can't emit control tags"). The content webview is a Tauri webview, so both globals are present.

Both variants call `installSniffer(event)`, which wires fetch / XHR / console shims and registers a single `event.listen(BRIDGE_EVENT, …)` that demuxes inbound `PageAction` / `CancelSnifferRequest` by the payload's `_tag` (and `PageAction` further by its inner `action.kind`). **No in-page `BrowserTopBar`** — the plugin draws native chrome on all three platforms, so the in-page bar is gone for good.

If neither transport is present (e.g. the page is opened outside a native webview), both bootstraps no-op end-to-end: no shims attach, no listeners register.

## Lifecycle: hide vs dispose

The native webview is the sniffer's **background runtime**, and visibility, liveness, and existence are independent:

- **`hide`** — a user dismissal (desktop titlebar X, iOS Close/swipe, Android Toolbar/back) removes it from view but keeps it **alive and running**. It emits `NativeWebviewEvent::Hidden`, which `native_webview_bridge::classify_event` re-emits to the SPA as a host-origin `UserDismissed` control message. That is a _signal_, not a terminal: the sniff continues in the background, and only a plan parked on an `AwaitUserDismiss` step acts on it. `SniffingComplete` stays **SPA-driven**, so a hide never ends the sniff by itself.
- **`dispose`** — the SPA's `SniffingComplete` is the terminal signal; `sniffing_complete::handle` calls `native_webview().dispose()`, which tears the webview down and frees resources, emitting `NativeWebviewEvent::Disposed`. That is re-emitted to the SPA as a `SnifferDisposed` control message — a **separate tag** from `UserDismissed`, because this teardown path fires on every run and the SPA must be able to tell ordinary shutdown apart from a user closing the window. A teardown backstop also disposes: app teardown on every platform, plus a 5-minute hidden-idle timeout on mobile.

Both tags are host-synthesized, so neither is in the page→host data-plane allowlist: a sniffed page that could forge either would be able to cut an `AwaitUserDismiss` hold short and end collection early.

## Dispose-then-reopen ("switch demos") race

A `SniffingComplete`-followed-by-`RequestSniffableWebView` arrives as two sequential bridge events on the same main-thread listener tick. The plugin's window close (issued by `dispose()`) on desktop only **queues** the OS-level close via `proxy.send_event(Message::Window(..., Close))` (see `tauri-runtime-wry`'s `WindowDispatcher::close`), so the same-tick reopen runs **before** the dispose is processed.

The plugin handles this via a **cancelable dispose**: `dispose()` flips an app-managed `disposing` flag before asking the runtime to close, the same-tick `present()` (from `open_url`) stashes its `OpenRequest` into `pending_reopen` instead of building against the doomed window, and the window's `CloseRequested` handler reads `pending_reopen` to either:

- **`Some(payload)`** → `api.prevent_close()` and rewire the live webviews against the new request (channel, initScript, chrome, URL).
- **`None`** → let the dispose proceed; `Destroyed` fires → `Disposed`.

The `CloseRequested` handler also distinguishes a **user dismissal** (the desktop titlebar X): when `disposing` is NOT set, it cancels the close and **hides** instead (`prevent_close` + `window.hide()` + emit `Hidden`), so a user dismissal keeps the webview alive — only `dispose()` tears down. iOS/Android use the analogous `isDisposing`-gated deferred-replay; a hide never arms it.

## Re-wire on a stacked second `open_url()`

The plugin's `open_url()` is idempotent: a second call while a native webview is up does NOT stack a new one. Instead it rebinds the existing native webview's `Channel<NativeWebviewEvent>`, re-injects the new `initScript`, re-applies caller-supplied initial chrome, and navigates the content webview to the new URL.

**InitScript caveat**: the original script was wired into the webview's document-start hook at build time, and platform APIs don't let us swap that hook after build. On rewire, the new script lands via `eval` — typically AFTER the page's own document-start scripts on the navigating page, not before. iOS and Android also add the new script to the user content controller for **future** loads inside this native webview (those will be document-start), but the immediate navigation that triggered the rewire is best-effort. The sniffer's bundle is stable across opens so the difference is invisible to it; callers that rely on document-start semantics across stacked opens should be aware.

## Initial chrome at presentation time

The sniffer passes `initial_subtitle: "Collecting Automatically"` to `open_url()` so the native webview's first paint already shows the sniffer status — vs. a post-open `patch_window_text` call that would race the chrome bar's build on desktop (the chrome webview isn't ready until after `add_child` resolves). Title defaults to the URL host on every fresh build; `message` is reserved for future per-request counters.

Once the collector's automatic-navigation machine starts stepping, each step's `SetSnifferStatus { name }` **overwrites** that subtitle via `sniffer_window::set_status` (`patch_window_text`), so `"Collecting Automatically"` is just the pre-first-step default. That post-open patch is safe here — the first named step is emitted no earlier than the start-up `PageLoaded`, by which time the chrome exists, and `patch_window_text` returns `set: false` (never an error) if it doesn't.

## Crate layout

```text
browser-sniffer-tauri-rust/
├── src/
│   ├── lib.rs                       — public surface + `attach_browser_sniffer` glue
│   ├── events.rs                    — event-name constants (drift guard against the TS side)
│   ├── bootstrap.rs                 — `include_str!` of the per-target TS-generated IIFE
│   ├── sniffer_window.rs            — `open_or_navigate` + `set_status` (plugin call sites)
│   ├── native_webview_bridge.rs     — `NativeWebviewChannel` + `Channel<NativeWebviewEvent>` handler + mobile `evaluate_js` forwarder
│   ├── model/
│   │   ├── request_sniffable_webview.rs — `RequestSniffableWebViewPayload`
│   │   ├── open.rs                  — `OpenPayload`
│   │   ├── set_sniffer_status.rs    — `SetSnifferStatusPayload`
│   │   └── web_view_source.rs       — `WebViewSourcePayload`, `resolve_source`, `SourceResolveError`
│   └── handlers/
│       ├── request_sniffable_webview.rs
│       ├── open.rs
│       ├── set_sniffer_status.rs
│       └── sniffing_complete.rs
└── Cargo.toml
```

Doc-comments at the top of each file should be quick references useful on hover. The full prose lives here.

## Key file references

- [`browser-sniffer-tauri-rust/src/lib.rs`](../browser-sniffer-tauri-rust/src/lib.rs) — entry point; wires the single bridge listener.
- [`browser-sniffer-tauri-rust/src/sniffer_window.rs`](../browser-sniffer-tauri-rust/src/sniffer_window.rs) — the only file that calls `native_webview().open_url(...)`.
- [`browser-sniffer-tauri-rust/src/native_webview_bridge.rs`](../browser-sniffer-tauri-rust/src/native_webview_bridge.rs) — channel handler: validates inbound native-webview `Message`s and re-emits them on `BRIDGE_EVENT`; logs `Hidden` / `Disposed` lifecycle events (non-terminal — `SniffingComplete` is SPA-driven).
- [`browser-sniffer-tauri/src/install-sniffer.ts`](../browser-sniffer-tauri/src/install-sniffer.ts) — fetch / XHR / console shim emitting on `BRIDGE_EVENT` via `eventBus.emit`.
- [`browser-sniffer-tauri/src/native-bridge.ts`](../browser-sniffer-tauri/src/native-bridge.ts) — `makeNativeBridgeEventBus`, the `TauriEventApi`-shaped bus over the plugin's native bridge.
- [`browser-sniffer-tauri/src/tauri-sniffer-entry.ts`](../browser-sniffer-tauri/src/tauri-sniffer-entry.ts) — desktop IIFE wrapper.
- [`browser-sniffer-tauri/src/native-sniffer-entry.ts`](../browser-sniffer-tauri/src/native-sniffer-entry.ts) — mobile IIFE wrapper.
- [`slices/collector/collector-fundamentals/src/bridge.ts`](../../collector/collector-fundamentals/src/bridge.ts) — consumer-side bridge schema; the Rust payload structs in `model/{request_sniffable_webview,open}.rs` mirror its shapes.
- [`plugins/tauri-plugin-native-webview/docs/Explanation.md`](../../../plugins/tauri-plugin-native-webview/docs/Explanation.md) — plugin's own architecture write-up.
