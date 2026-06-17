// Entry point used by `scripts/build-tauri-bootstrap.mts` to produce
// the self-invoking IIFE injected into Tauri sniffer webviews via
// `WebviewWindowBuilder::initialization_script(...)`. The bundle adapts
// the `react-native-webview` postMessage contract that the unmodified
// `installSniffer()` uses to Tauri's per-tag event bus (`bridge:{tag}` —
// the same convention pinned by `effect-messaging-tauri/event-names.ts`),
// then invokes the sniffer.
//
// `window.__TAURI__` is present inside the sniffer webview because the
// app's `tauri.conf.json` sets `app.withGlobalTauri: true`, which Tauri
// codegen prepends to every webview's init-script list at runtime — no
// per-builder opt-in is needed.
//
// Outbound: `window.ReactNativeWebView.postMessage(jsonStr)` — the
// sniffer's only outbound channel — JSON-parses and emits
// `bridge:{_tag}` with the structured payload. The main webview's
// `makeTauriTransport` listener for that tag receives it directly:
// Tauri events broadcast to every listener, so no Rust-side forwarding
// is needed for the data plane.
//
// Inbound: `BrowserSnifferBridge.HostToWeb` declares `Click` and
// `CancelSnifferRequest`. We listen on the matching Tauri events and
// dispatch a synthetic `window` `message` event with `source: null`
// (set explicitly — the spec default is `null`, but documenting the
// contract here removes any engine-quirk footgun) — exactly the channel
// the sniffer's `addEventListener('message', …)` handler reads.

import type { UnlistenFn } from '@tauri-apps/api/event'

import { installSniffer } from 'browser-sniffer-injected'

interface TauriEventEnvelope<T = unknown> {
  readonly payload: T
}

interface TauriEventApi {
  readonly emit: (event: string, payload?: unknown) => Promise<void>
  readonly listen: <T = unknown>(
    event: string,
    handler: (event: TauriEventEnvelope<T>) => void
  ) => Promise<UnlistenFn>
}

interface TauriGlobals {
  readonly event?: TauriEventApi
}

interface SnifferWindowExtensions {
  ReactNativeWebView?: {
    postMessage(data: string): void
  }
  __TAURI__?: TauriGlobals
  // Stash of pending unlisten functions registered by the previous run
  // of this script. The init script re-runs on every navigation inside
  // the sniffer webview, so without cleanup the Rust-side listener
  // registry would grow unbounded — each `event.listen(...)` allocates
  // a fresh listener ID and the old IDs would dispatch into the new
  // page's JS context where they no longer resolve. We drain this
  // slot before re-registering.
  __SNIFFER_TAURI_UNLISTEN__?: Array<UnlistenFn | Promise<UnlistenFn>>
}

const win = globalThis as typeof globalThis & SnifferWindowExtensions
// oxlint-disable-next-line no-underscore-dangle -- `__TAURI__` is the Tauri 2 globals namespace.
const event = win.__TAURI__?.event

if (event !== undefined) {
  // Drain any unlistens left over from a previous page in this webview.
  // `event.listen` returns Promise<UnlistenFn>; the previous run may have
  // stashed promises that haven't resolved yet (the `await`-less style
  // we use below). Resolve-then-call handles both shapes.
  // oxlint-disable-next-line no-underscore-dangle
  const priorUnlistens = win.__SNIFFER_TAURI_UNLISTEN__ ?? []
  for (const entry of priorUnlistens) {
    void Promise.resolve(entry).then((unlisten) => {
      unlisten()
    })
  }
  const pendingUnlistens: Array<UnlistenFn | Promise<UnlistenFn>> = []
  // oxlint-disable-next-line no-underscore-dangle
  win.__SNIFFER_TAURI_UNLISTEN__ = pendingUnlistens

  // Outbound: replace `window.ReactNativeWebView.postMessage` (the
  // sniffer's only outbound channel) with a Tauri-event emitter. The
  // sniffer always calls `JSON.stringify(msg)` before posting, so
  // JSON.parse round-trips the structured message we hand to
  // `event.emit` — letting `makeTauriTransport`'s `Schema.typeSchema`
  // decode on the main side without any string envelope.
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
    const promise = event.listen(`bridge:${tag}`, ({ payload }) => {
      // `source: null` explicit so the sniffer's `event.source !== null`
      // drop guard always passes — engine quirks aside.
      const data = JSON.stringify(payload)
      win.dispatchEvent(new MessageEvent('message', { data, source: null }))
    })
    pendingUnlistens.push(promise)
  }

  // Without a working Tauri event bus the bootstrap can't carry any
  // sniffer traffic — gating `installSniffer()` here keeps an arbitrary
  // page free of fetch/XHR/console wrappers it can never observe.
  installSniffer()
}
