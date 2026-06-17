// Entry point used by `scripts/build-tauri-bootstrap.mts` to produce
// the self-invoking IIFE injected into Tauri sniffer webviews via
// `WebviewBuilder::initialization_script(...)`. The bundle adapts the
// `react-native-webview` postMessage contract that the unmodified
// `installSniffer()` uses to Tauri's per-tag event bus
// (`bridge:{tag}` — the same convention pinned by
// `effect-messaging-tauri/event-names.ts`), then invokes the sniffer.
//
// The Rust host (`browser-sniffer-tauri-rust`) constructs the webview
// with `WebviewBuilder::with_global_tauri(true)`, so `window.__TAURI__`
// is present before this script runs.
//
// Outbound: `window.ReactNativeWebView.postMessage(jsonStr)` — the
// sniffer's only outbound channel — JSON-parses and emits
// `bridge:{_tag}` with the structured payload. The main webview's
// `makeTauriTransport` listener for that tag (registered via
// `CollectorBridge.hostToWeb` in
// `apps/wildflower-react/src/bridges/bridges.ts`) receives it directly:
// Tauri events broadcast to every listener, so no Rust-side forwarding
// is needed for the data plane.
//
// Inbound: `BrowserSnifferBridge.HostToWeb` declares `Click` and
// `CancelSnifferRequest`. We listen on the matching Tauri events and
// dispatch a synthetic `window` `message` event whose `data` is the
// JSON-stringified payload. The sniffer's host-message handler in
// `install-sniffer.ts` rejects events whose `source` is not `null`;
// `MessageEvent`'s default for `source` is `null`, so a constructed
// `new MessageEvent('message', { data })` is exactly the channel the
// sniffer reads.

import { installSniffer } from 'browser-sniffer-injected'

interface TauriEventEnvelope {
  readonly payload: unknown
}

interface TauriEventApi {
  readonly emit: (event: string, payload?: unknown) => Promise<void>
  readonly listen: (
    event: string,
    handler: (event: TauriEventEnvelope) => void
  ) => Promise<() => void>
}

interface TauriGlobals {
  readonly event?: TauriEventApi
}

interface SnifferWindowExtensions {
  ReactNativeWebView?: {
    postMessage(data: string): void
  }
  __TAURI__?: TauriGlobals
}

const win = globalThis as typeof globalThis & SnifferWindowExtensions
// oxlint-disable-next-line no-underscore-dangle -- `__TAURI__` is the Tauri 2 globals namespace.
const event = win.__TAURI__?.event

if (event !== undefined) {
  // Outbound: replace `window.ReactNativeWebView.postMessage` (the
  // sniffer's only outbound channel — see `install-sniffer.ts`'s
  // `post()` helper) with a Tauri-event emitter. The sniffer always
  // calls `JSON.stringify(msg)` before posting, so JSON.parse round-trips
  // the structured message we hand to `event.emit` — letting
  // `makeTauriTransport`'s `Schema.typeSchema` decode on the main side
  // without any string envelope.
  win.ReactNativeWebView = {
    postMessage(jsonStr: string): void {
      let parsed: unknown
      try {
        parsed = JSON.parse(jsonStr)
      } catch {
        // The sniffer's `post()` always emits valid JSON-stringified
        // structs; a parse failure here means the contract has drifted.
        // Drop silently — there is no transport to surface this on yet.
        return
      }
      if (parsed === null || typeof parsed !== 'object' || !('_tag' in parsed)) return
      const tag = (parsed as { _tag: unknown })._tag
      if (typeof tag !== 'string') return
      void event.emit(`bridge:${tag}`, parsed)
    },
  }

  // Inbound: `BrowserSnifferBridge.hostToWeb` declares exactly these two
  // tags. Keep the list inline — adding a third tag here without adding
  // it to the bridge schema (or vice versa) is a drift caught by the
  // tests in `tests/bootstrap.test.ts`.
  const inboundTags = ['Click', 'CancelSnifferRequest'] as const
  for (const tag of inboundTags) {
    void event.listen(`bridge:${tag}`, ({ payload }) => {
      // `MessageEventInit.source` defaults to `null`, matching the
      // `event.source === null` guard the sniffer's host-message
      // handler enforces (`install-sniffer.ts:590`) — so this dispatch
      // is exactly the channel the sniffer reads.
      const data = JSON.stringify(payload)
      win.dispatchEvent(new MessageEvent('message', { data }))
    })
  }
}

installSniffer()
