# Browser Sniffer — Architecture Explanation

## What this slice is

A generic page-sniffing primitive. Three packages, each independent of any consuming slice:

- **`browser-sniffer-core`** — message schemas (the six events the sniffer posts) and `BrowserSnifferBridge` (an `effect-messaging-core` bridge declaring those messages as `Web→Host`).
- **`browser-sniffer-injected`** — the actual JS that goes into a third-party page. Real TypeScript source (`src/install-sniffer.ts`); a string export (`snifferScript`) ready to drop into `react-native-webview`'s `injectedJavaScriptBeforeContentLoaded`.
- **`browser-sniffer-expo`** — `<BrowserSnifferWebView>`, a `react-native-webview` wrapper that injects the script pre-content-load and dispatches incoming messages through `BridgeTransport`'s `Host` side.

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
6. Exposes `window.cancelSnifferRequest(id)` so the host can stop pumping events for a specific in-flight request via `webRef.injectJavaScript(...)` (no Host→Web bridge entry needed).

Idempotent: re-injecting on the same page short-circuits each shim on its `window.native*` shadow.

## Why a separate slice

The sniffer is **upstream** of collector (and any future scraper). It has no opinions about what the captured responses _mean_ — that's the consumer's job. Splitting it out means:

- The injected JS can evolve (new shims, new event types) without touching collector.
- A future scraper (e.g. one that consumes scraped emails or a different web app's API) can reuse the same primitive without inheriting collector's FHIR-shaped abstractions.
- Tests for the sniffer mechanics (chunk reconstruction, base64 round-trip, XHR reuse guards) live next to the code they exercise instead of leaking into a downstream package.

The slice rule says "slices should not depend on other slices unless intrinsic — document why if you do." Collector depends on browser-sniffer intrinsically: collector is built around consuming sniffer events. That dependency direction is one-way (browser-sniffer knows nothing about collector).

## Data flow in the wider system

The sniffer is half of a two-bridge sync. The other half — `CollectorBridge` — lives in `slices/collector/collector-core` and is added when the collector slice migrates. The flow once both are in place:

```
[collector-react SPA, inside <CollectorWebView>]
    │ user taps "Import Now"
    │ collectorTransport.sendMessage({ _tag: 'RequestSniffableWebView', source: {...} })
    ▼
[Expo host's CollectorBridge.Host receiver]
    │ pushes a screen rendering <BrowserSnifferWebView source={...}> alongside the still-mounted <CollectorWebView>
    ▼
[<BrowserSnifferWebView> — this slice]
    │ injects snifferScript pre-content-load
    │ sniffer posts __Ready, then ResponseStart / ResponseData / etc. via window.ReactNativeWebView.postMessage
    │ BridgeTransport.Host dispatches each event to its supplied handler
    ▼
[Host's BrowserSnifferBridge handlers, supplied by the parent screen]
    │ forward the four collector-relevant tags onto collectorTransport.sendMessage
    │ (ResponseStart, ResponseData, ResponseFinished, RequestError)
    ▼
[collector-react SPA's CollectorBridge.Web receiver]
    │ feeds events into a FhirR4Remote (or other Remote) for parsing
    │ writes resources via same-origin PUT /fhir-r4/*
```

The host is a pure router: it instantiates two bridges, holds a ref to the CollectorWebView's transport, and forwards selected sniffer events. No parsing logic in the host.

## Why `installSniffer.toString()` (not a Vite bundle plugin)

Earlier drafts considered a Vite plugin that built `src/install-sniffer.ts` to an IIFE and emitted a string wrapper. The simpler approach won: `Function.prototype.toString()` on the function gives the runtime-evaluated body, which tsdown/Vite have already transpiled. Both source-condition (vp pack output) and Vitest dev work uniformly with one definition.

This places a constraint on the function: **no module-scope dependencies**. Every helper, every type-erased reference, every cross-call piece of state must live inside the function body. Top-level imports or closures over module scope would resolve to nothing when the stringified body is `new Function(...)`-evaluated in the injected page. See `install-sniffer.ts` for the precise guardrails.

## What's deliberately not here

- **Effect-Messaging Web side**: The sniffer runs in _arbitrary_ third-party pages — it can't depend on our SPA bundle's `WebPlatformAdapter`. So it speaks the wire format manually (`JSON.stringify({_tag:..., ...})`) and the host decodes it through `BridgeTransport`'s `Host` side only. The `__Ready` message is the one piece of `BridgeTransport`'s protocol the sniffer participates in directly.

- **A Host→Web channel**: `BrowserSnifferBridge.hostToWeb` is empty. Cancellation (the only host→sniffer signal today) goes via `injectJavaScript('window.cancelSnifferRequest(...)')`, which keeps the sniffer page-level rather than transport-level. If a future need for typed host messages emerges (e.g. "pause sniffing for these URL patterns"), the handshake is already wired so `BridgeTransport.sendMessage` will work as soon as a `hostToWeb` entry lands.

- **A web-side test harness**: Tests live in `browser-sniffer-injected/src/install-sniffer.test.ts` against a Vitest jsdom env, calling `installSniffer()` directly and observing `window.ReactNativeWebView.postMessage` mocks. We also round-trip through `new Function(snifferScript)()` to guard against `toString()` losing semantic information.

## Where to look next

- `browser-sniffer-core/src/bridge.ts` — the typed contract.
- `browser-sniffer-core/src/messages.ts` — the six event schemas.
- `browser-sniffer-injected/src/install-sniffer.ts` — the actual shimming code.
- `browser-sniffer-expo/src/components/BrowserSnifferWebView.tsx` — the React Native host component.
- `slices/collector/collector-core/src/bridge.ts` (lands in a later PR) — the consumer side; re-uses message schemas from `browser-sniffer-core` so the wire format stays in lockstep.
