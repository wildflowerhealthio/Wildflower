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

// Tauri's IPC transport (`@tauri-apps/api`) calls `fetch('ipc://localhost/...')`
// from inside the same JS context the sniffer's fetch shim runs in, so
// every Tauri IPC call gets re-sniffed and forwarded back as a
// `bridge:ResponseStart`/`bridge:RequestError` pair pointing at the
// internal IPC URL. On macOS the fetch is also blocked by WebKit's
// mixed-content gate (top-level https://, custom `ipc:` subresource);
// Tauri's protocol script catches that and retries via the wry
// `WKScriptMessageHandler` postMessage path, but the failed fetch leaks
// out as console.warn-flooded host logs and confuses the collector with
// untracked-id errors. Filter both at the bridge shim:
//
//   - Tag the request id at `ResponseStart` if the URL is Tauri-internal
//     (`ipc://` / `tauri://localhost` / `http(s)://ipc.localhost` /
//      `http(s)://tauri.localhost`). Drop subsequent `ResponseData`,
//     `ResponseFinished`, `RequestError`, `Cancelled` events for the
//     same id so the collector never sees them.
//   - Drop `Log` events whose first payload entry is Tauri's IPC
//     fallback warning. The warning is expected (and self-resolving
//     after the first call flips `customProtocolIpcFailed`); per-call
//     log spam is not useful.
const isTauriInternalUrl = (url: unknown): boolean => {
  if (typeof url !== 'string') return false
  return (
    url.startsWith('ipc://')
    || url.startsWith('tauri://')
    || url.startsWith('http://ipc.localhost')
    || url.startsWith('https://ipc.localhost')
    || url.startsWith('http://tauri.localhost')
    || url.startsWith('https://tauri.localhost')
  )
}

const TAURI_IPC_FALLBACK_WARN_PREFIX = 'IPC custom protocol failed'
const SNIFFER_FETCH_THREW_WARN_PREFIX = 'fetch threw before response:'

const isTauriIpcFallbackWarning = (parsed: Record<string, unknown>): boolean => {
  if (parsed.level !== 'warn') return false
  const payload = parsed.payload
  if (!Array.isArray(payload) || payload.length === 0) return false
  const head = payload[0]
  return typeof head === 'string' && head.startsWith(TAURI_IPC_FALLBACK_WARN_PREFIX)
}

const isSnifferFetchThrewWarning = (parsed: Record<string, unknown>): boolean => {
  if (parsed.level !== 'warn') return false
  const payload = parsed.payload
  if (!Array.isArray(payload) || payload.length === 0) return false
  const head = payload[0]
  return typeof head === 'string' && head.startsWith(SNIFFER_FETCH_THREW_WARN_PREFIX)
}

const internalRequestIds = new Set<string>()

// install-sniffer's fetch shim emits a `Log` *immediately* before a
// `ResponseStart` carrying the failing URL whenever fetch throws (see
// the `catch` block in `install-sniffer.ts`). The sniffer doesn't know
// whether the failing fetch was a real cross-origin request from the
// page or one of Tauri's own `ipc://` IPC fetches that WebKit's
// mixed-content gate blocked, so we buffer the Log here and decide
// based on the URL on the next `ResponseStart`:
//   - URL is Tauri-internal (`ipc://`, `tauri://`, …) → drop the Log
//     (the failing fetch was Tauri's own IPC, which has a postMessage
//     fallback that handles this transparently)
//   - URL is anything else → forward the Log so real page-fetch
//     failures (CORS, SSL, network) stay visible
// A safety drain: if any non-`ResponseStart` event lands while a Log
// is buffered, forward the Log; the buffered Log is then dropped from
// the state regardless.
let bufferedFetchErrorLog: Record<string, unknown> | null = null

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

      const record = parsed as Record<string, unknown>

      if (tag === 'Log' && isTauriIpcFallbackWarning(record)) return

      // Buffer the "fetch threw before response:" Log: install-sniffer
      // emits this Log synchronously right before the ResponseStart
      // carrying the failing URL. Decide whether to forward it on the
      // next event (see the drain below).
      if (tag === 'Log' && isSnifferFetchThrewWarning(record)) {
        bufferedFetchErrorLog = record
        return
      }

      // Drain the buffered Log first, deciding by the *current* event:
      // if it's a ResponseStart for a Tauri-internal URL, the Log was
      // about a blocked IPC fetch — drop it; otherwise forward it so
      // real page-fetch errors stay visible. Any non-ResponseStart
      // event also forwards the Log (the lookahead pairing only holds
      // for sync ResponseStart immediately after the warning).
      if (bufferedFetchErrorLog !== null) {
        const buffered = bufferedFetchErrorLog
        bufferedFetchErrorLog = null
        const isInternalResponseStart =
          tag === 'ResponseStart' && isTauriInternalUrl(record.url)
        if (!isInternalResponseStart) {
          void event.emit('bridge:Log', buffered)
        }
      }

      // Tag-time gate: record the id of any request whose start URL is
      // Tauri-internal so we can drop the per-chunk and terminal events
      // that follow without re-checking the URL (those events don't
      // carry one).
      if (tag === 'ResponseStart' && isTauriInternalUrl(record.url)) {
        if (typeof record.id === 'string') internalRequestIds.add(record.id)
        return
      }

      if (
        (tag === 'ResponseData'
          || tag === 'ResponseFinished'
          || tag === 'RequestError'
          || tag === 'Cancelled')
        && typeof record.id === 'string'
        && internalRequestIds.has(record.id)
      ) {
        if (tag === 'ResponseFinished' || tag === 'RequestError' || tag === 'Cancelled') {
          // Terminal event — release the id so the set doesn't grow
          // unboundedly across the page's lifetime.
          internalRequestIds.delete(record.id)
        }
        return
      }

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
