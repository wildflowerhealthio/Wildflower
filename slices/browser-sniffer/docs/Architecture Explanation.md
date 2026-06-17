# Browser Sniffer — Architecture Explanation

## What this slice is

A generic page-sniffing primitive. Four packages, each independent of any consuming slice:

- **`browser-sniffer-core`** — message schemas (the six events the sniffer posts) and `BrowserSnifferBridge` (an `effect-messaging-core` bridge declaring those messages as `Web→Host`).
- **`browser-sniffer-injected`** — the actual JS that goes into a third-party page. Real TypeScript source (`src/install-sniffer.ts`); a string export (`snifferScript`) the platform-adapter packages embed verbatim into whatever injection mechanism their webview offers.
- **`browser-sniffer-tauri`** — TypeScript bootstrap that adapts the sniffer's `ReactNativeWebView.postMessage` outbound convention onto Tauri's event bus and wraps `installSniffer()` for injection via `WebviewWindowBuilder::initialization_script`. Bundles to a self-contained IIFE (`embedded/tauri-bootstrap.js`) which the Rust crate includes via `include_str!`.
- **`browser-sniffer-tauri-rust`** — Tauri host plumbing. Listens for the lifecycle events on the bridge (`RequestSniffableWebView` → open the sniffer `WebviewWindow`, `Open` → navigate the existing one, `SniffingComplete` → close) and injects the bootstrap as the webview's initialization script.

No package in this slice knows about FHIR, collector, or any specific consumer. It's a primitive other slices compose with.

## What the sniffer captures

When `installSniffer()` runs in a page, it:

1. Posts `{"_tag":"__Ready"}` immediately (handshake for `BridgeTransport`'s send-gating `Deferred` — future-proofs for Host→Web messages).
2. Shims `window.fetch` and `XMLHttpRequest` so every response surfaces as a sequence of:
   - `ResponseStart { id, url, status, statusText, headers }`
   - One or more `ResponseData { id, data: base64 }` chunks
   - `ResponseFinished { id }`
3. Reports `RequestError { id, url, message }` on network failure (fetch reject, XHR `error` event).
4. Posts `PageLoaded { url, content }` once the window `load` event fires.
5. Posts ad-hoc `Log { log }` entries when shims install (single-shot diagnostics).
6. Accepts host→web `Click` and `CancelSnifferRequest` messages (the latter to stop pumping events for a specific in-flight request). On Tauri, the bootstrap delivers these by `event.listen`-ing the bridge channel and dispatching a synthetic `MessageEvent` with `source: null` — exactly the shape the sniffer's `window.addEventListener('message', …)` handler reads.

Idempotent: re-injecting on the same page short-circuits each shim on its `window.native*` shadow.

## Why a separate slice

The sniffer is **upstream** of collector (and any future scraper). It has no opinions about what the captured responses _mean_ — that's the consumer's job. Splitting it out means:

- The injected JS can evolve (new shims, new event types) without touching collector.
- A future scraper (e.g. one that consumes scraped emails or a different web app's API) can reuse the same primitive without inheriting collector's FHIR-shaped abstractions.
- Tests for the sniffer mechanics (chunk reconstruction, base64 round-trip, XHR reuse guards) live next to the code they exercise instead of leaking into a downstream package.

The slice rule says "slices should not depend on other slices unless intrinsic — document why if you do." Collector depends on browser-sniffer intrinsically: collector is built around consuming sniffer events. That dependency direction is one-way (browser-sniffer knows nothing about collector).

## Data flow in the wider system

The sniffer is half of a two-bridge sync. The other half — `CollectorBridge` — lives in `slices/collector/collector-core` and is added when the collector slice migrates. The flow once both are in place:

```text
[collector-react SPA, inside the main Tauri webview]
    │ user taps "Import Now"
    │ collectorTransport.sendMessage({ _tag: 'RequestSniffableWebView', source: {...} })
    ▼
[browser-sniffer-tauri-rust]
    │ listens on bridge:RequestSniffableWebView
    │ opens a top-level WebviewWindow with browser-sniffer-tauri's bootstrap
    │ as the initialization_script and navigates it to source.uri
    ▼
[sniffer WebviewWindow]
    │ Tauri's runtime + the bootstrap script wire window.__TAURI__ and an outbound
    │ ReactNativeWebView.postMessage shim before any page script runs
    │ installSniffer() shims fetch / XHR and posts __Ready, then
    │ ResponseStart / ResponseData / etc. via window.ReactNativeWebView.postMessage
    │ the bootstrap re-emits each as a structured message on the Tauri event bus
    ▼
[Tauri event bus]
    │ broadcasts the message to every webview listening on the bridge channel
    ▼
[collector-react SPA's CollectorBridge.Web receiver, in the main webview]
    │ feeds events into a FhirR4Remote (or other Remote) for parsing
    │ writes resources via same-origin PUT /fhir-r4/*
```

The Rust host is a pure router: it listens for the four lifecycle tags (`RequestSniffableWebView`, `Open`, `SniffingComplete`, plus `Click` rerouting if a slice uses it), opens/navigates/closes the sniffer `WebviewWindow`, and lets the data-plane events fan out through Tauri's event bus unmodified. No parsing logic in the host.

## Why `installSniffer.toString()` (not a Vite bundle plugin)

Earlier drafts considered a Vite plugin that built `src/install-sniffer.ts` to an IIFE and emitted a string wrapper. The simpler approach won: `Function.prototype.toString()` on the function gives the runtime-evaluated body, which tsdown/Vite have already transpiled. Both source-condition (vp pack output) and Vitest dev work uniformly with one definition.

This places a constraint on the function: **no module-scope dependencies**. Every helper, every type-erased reference, every cross-call piece of state must live inside the function body. Top-level imports or closures over module scope would resolve to nothing when the stringified body is `new Function(...)`-evaluated in the injected page. See `install-sniffer.ts` for the precise guardrails.

## What's deliberately not here

- **Effect-Messaging Web side**: The sniffer runs in _arbitrary_ third-party pages — it can't depend on our SPA bundle's `WebPlatformAdapter`. So it speaks the wire format manually (`JSON.stringify({_tag:..., ...})`) and the host decodes it through `BridgeTransport`'s `Host` side only. The `__Ready` message is the one piece of `BridgeTransport`'s protocol the sniffer participates in directly.

- **A Tauri-shaped Web platform adapter inside the sniffer page**: the sniffer page is a _third-party_ origin; it can't import our SPA bundle or `@tauri-apps/api` modules at build time. The Tauri bootstrap relies on `withGlobalTauri: true` to surface `window.__TAURI__.event`, then runs everything else as plain script — no SDK, no Effect runtime, no schema decoder. The bridge wire format is parsed by hand on both sides for the same reason `installSniffer.toString()` constrains the sniffer body: nothing in the injected page can assume a module loader.

- **A web-side test harness**: Tests live in `browser-sniffer-injected/src/install-sniffer.test.ts` against a Vitest jsdom env, calling `installSniffer()` directly and observing `window.ReactNativeWebView.postMessage` mocks. We also round-trip through `new Function(snifferScript)()` to guard against `toString()` losing semantic information.

## Where to look next

- `browser-sniffer-core/src/bridge.ts` — the typed contract.
- `browser-sniffer-core/src/messages.ts` — the six event schemas.
- `browser-sniffer-injected/src/install-sniffer.ts` — the actual shimming code.
- `browser-sniffer-tauri/src/tauri-sniffer-entry.ts` — the Tauri bootstrap that adapts the postMessage convention onto Tauri's event bus.
- `browser-sniffer-tauri-rust/src/lib.rs` — the Rust host plumbing that opens / navigates / closes the sniffer `WebviewWindow`.
- `slices/collector/collector-fundamentals/src/bridge.ts` — the consumer-side bridge; re-uses message schemas from `browser-sniffer-core` so the wire format stays in lockstep.
