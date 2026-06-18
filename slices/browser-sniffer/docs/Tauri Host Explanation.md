# Tauri Host Explanation

How `browser-sniffer-tauri-rust` (Rust) and `browser-sniffer-tauri` (TS) work together to run the sniffer inside a Tauri webview.

## What the crate is

A pure event-bus router. The Rust side listens for three SPA-emitted `CollectorBridge.webToHost` events on Tauri's global event bus and translates them into webview lifecycle operations:

| Event                            | Effect                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge:RequestSniffableWebView` | Create the sniffer `WebviewWindow` (top-level webview) with the TS bootstrap wired in via `WebviewWindowBuilder::initialization_script(...)`. |
| `bridge:Open`                    | Navigate the existing sniffer webview to a new source. The init script re-runs on every navigation, so the sniffer re-installs idempotently.  |
| `bridge:SniffingComplete`        | Close the sniffer webview. The main webview's React SPA stays mounted.                                                                        |

No Rust-side forwarding for the data plane. Sniffer-emitted `bridge:ResponseStart` / `ResponseData` / `PageLoaded` / etc. land directly on the main webview's `makeTauriTransport` listeners because Tauri events broadcast to every webview AND to the Rust side — `CollectorBridge` re-exports `BrowserSnifferBridge`'s webToHost schemas as its own hostToWeb messages, so the tag names line up exactly.

## Why `WebviewWindow` and not `Window::add_child`

`Window::add_child` is gated behind `desktop + unstable` features in Tauri 2.11 (`tauri-2.11.2/src/window/mod.rs:1127`) and does not compile for mobile targets. `WebviewWindow` works across desktop and mobile — on desktop the sniffer presents as a separate OS window, on mobile as a separate native view/screen, matching the user's intent of "open an iOS or Android webview over the existing app".

## Race between `SniffingComplete` and a follow-up open

`WebviewWindow::close()` is a request to the platform, not a synchronous teardown — Tauri's `get_webview_window(label)` may still find a closing window for one or more event-loop ticks. If the SPA emits `SniffingComplete` immediately followed by a fresh `RequestSniffableWebView` ("switch demos" UX), the lookup race could route the second event into the navigate-in-place branch against a doomed window — the SPA would never see the new sniffer.

The fix lives in `sniffer_window.rs`: an `AtomicBool` sentinel (`SNIFFER_OPEN`) tracks our own belief about the slot's state. `handle_sniffing_complete` flips it to `false` _before_ asking Tauri to close, so a follow-up open always takes the fresh-build path. The Tauri lookup is still consulted (as an idempotency check), but it's no longer the source of truth.

## Why a single embedded bootstrap

The TS side (`browser-sniffer-tauri`) bundles `tauri-sniffer-entry.ts` (which imports `installSniffer` from the sibling `install-sniffer.ts`) into a self-contained IIFE and writes it as raw JS. The Rust crate `include_str!`s those bytes at compile time, so the sniffer webview always ships a frozen snapshot — no runtime fetch, no filesystem lookup at process start, no path management for the host `.app` bundle.

The bootstrap is responsible for:

1. Looking up `globalThis.__TAURI__.event` (the structural `TauriEventApi` exported by `effect-messaging-tauri`).
2. Injecting the in-page `BrowserTopBar` (closed shadow DOM, Close button + URL label) so the sniffer webview reads as a sub-context on iOS where there's no native browser chrome. The Close button emits `{ _tag: 'SniffingComplete' }` on the `BRIDGE_EVENT` channel.
3. Calling `installSniffer(event)` — the sniffer body wires the fetch / XHR / console shims and registers a single `event.listen(BRIDGE_EVENT, …)` that demuxes inbound `Click` / `CancelSnifferRequest` by the payload's `_tag`. No `window.ReactNativeWebView.postMessage` shim, no synthetic `MessageEvent` dispatch.

When `__TAURI__` is absent (e.g. config drift removed `withGlobalTauri`) the bootstrap no-ops end-to-end: no shims attach, no BrowserTopBar attaches, no listeners register.

`window.__TAURI__` is present inside the sniffer webview because `app.withGlobalTauri: true` in `tauri.conf.json` is baked in at codegen time (`tauri-codegen/src/context.rs`) and prepended to every webview's init-script list at runtime (`tauri/src/manager/webview.rs`) — the bootstrap doesn't need to call any per-webview API to opt in.

## Crate layout

```text
browser-sniffer-tauri-rust/
├── src/
│   ├── lib.rs                       — public surface + `attach_browser_sniffer` glue
│   ├── events.rs                    — event-name constants (drift guard against the TS side)
│   ├── bootstrap.rs                 — `include_str!` of the TS-generated IIFE
│   ├── sniffer_window.rs            — `open_or_navigate` + `AtomicBool` race sentinel
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

- `browser-sniffer-tauri-rust/src/lib.rs` — entry point; wires three `app.listen(...)` calls.
- `browser-sniffer-tauri-rust/src/sniffer_window.rs` — the only file that talks to Tauri's `WebviewWindowBuilder`.
- `browser-sniffer-tauri/src/install-sniffer.ts` — the fetch / XHR / console shim that emits structured payloads on the multiplexed `BRIDGE_EVENT` channel directly via `eventBus.emit`.
- `browser-sniffer-tauri/src/tauri-sniffer-entry.ts` — the thin IIFE wrapper that gates on `window.__TAURI__.event`, injects the `BrowserTopBar`, and hands the event API to `installSniffer`.
- `slices/collector/collector-fundamentals/src/bridge.ts` — the consumer-side bridge schema; the Rust payload structs in `model/{request_sniffable_webview,open}.rs` mirror its shapes.
