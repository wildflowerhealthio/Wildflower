import type { TauriEventApi } from 'effect-messaging-tauri'

import { BRIDGE_EVENT } from './install-sniffer.ts'

/**
 * Tauri-internal traffic filter for the sniffer's multiplexed
 * `BRIDGE_EVENT` Tauri channel.
 *
 * Why: Tauri's IPC transport (`@tauri-apps/api`) calls
 * `fetch('ipc://localhost/...')` from inside the same JS context the
 * sniffer's fetch shim runs in, so every Tauri IPC call gets re-sniffed
 * and forwarded back as a `ResponseStart` / `RequestError` pair pointing
 * at the internal IPC URL. On macOS the fetch is also blocked by
 * WebKit's mixed-content gate (top-level https://, custom `ipc:`
 * subresource); Tauri's protocol script catches that and retries via
 * the wry `WKScriptMessageHandler` postMessage path, but the failed
 * fetch leaks out as `console.warn`-flooded host logs and confuses the
 * collector with untracked-id errors. Two filters cooperate to clean
 * the stream:
 *
 *   1. Tag the request id at `ResponseStart` if the URL is Tauri-internal
 *      (`ipc://` / `tauri://localhost` / `http(s)://ipc.localhost` /
 *      `http(s)://tauri.localhost`). Drop subsequent `ResponseData`,
 *      `ResponseFinished`, `RequestError`, `Cancelled` events for the
 *      same id so the collector never sees them.
 *   2. Drop `Log` events whose first payload entry is Tauri's IPC
 *      fallback warning. The warning is expected (and self-resolving
 *      after the first call flips `customProtocolIpcFailed`); per-call
 *      log spam is not useful.
 *
 * A third filter handles the sniffer's own `"fetch threw before
 * response:"` warning: install-sniffer's fetch shim emits it
 * synchronously immediately before the `ResponseStart` carrying the
 * failing URL, but at warn-time we don't know if it's a real
 * page-fetch failure or Tauri's own blocked IPC. Buffer the Log and
 * decide on the very next event (see {@link makeFilteringEventBus}).
 *
 * The wrapper also serializes outbound emits on a Promise chain so a
 * synchronous burst from the sniffer (e.g. `pageLoadHandler` emitting
 * `PageLoaded` + `ResponseStart` + N×`ResponseData` + `ResponseFinished`
 * in one tight loop) cannot get reordered by Tauri's IPC fallback
 * dance: the first emit drains the fetch-path retry, after which
 * `customProtocolIpcFailed` is sticky and every subsequent emit goes
 * straight to the synchronous postMessage path (FIFO at the
 * WKWebView message-handler layer). Net latency cost is one
 * round-trip per burst, not per chunk.
 */

const isTauriInternalUrl = (url: unknown): boolean => {
  if (typeof url !== 'string') return false
  return (
    url.startsWith('ipc://') ||
    url.startsWith('tauri://') ||
    url.startsWith('http://ipc.localhost') ||
    url.startsWith('https://ipc.localhost') ||
    url.startsWith('http://tauri.localhost') ||
    url.startsWith('https://tauri.localhost')
  )
}

const TAURI_IPC_FALLBACK_WARN_PREFIX = 'IPC custom protocol failed'
const SNIFFER_FETCH_THREW_WARN_PREFIX = 'fetch threw before response:'

/**
 * A `Log` record at `warn` level whose first payload entry is a string
 * starting with `prefix`. Both Tauri-internal warnings the filter cares
 * about share this shape; they differ only in the prefix literal.
 */
const isWarnWithHeadPrefix = (record: Record<string, unknown>, prefix: string): boolean => {
  if (record.level !== 'warn') return false
  const payload = record.payload
  if (!Array.isArray(payload) || payload.length === 0) return false
  const head: unknown = payload[0]
  return typeof head === 'string' && head.startsWith(prefix)
}

/**
 * Wrap a {@link TauriEventApi} so outbound `BRIDGE_EVENT` emits pass
 * through the Tauri-internal filter described in this module's header.
 * `listen` and any emit whose name is not `BRIDGE_EVENT` pass through
 * unchanged.
 *
 * Closure state (the set of known-internal request ids, the
 * single-event Log lookahead buffer, and the outbound emit-chain
 * Promise) lives on the wrapper instance — one wrapper per page is the
 * intended use; tests construct a fresh wrapper per case.
 */
const makeFilteringEventBus = (eventBus: TauriEventApi): TauriEventApi => {
  const internalRequestIds = new Set<string>()
  // install-sniffer's fetch shim emits a `Log` *immediately* before a
  // `ResponseStart` carrying the failing URL whenever fetch throws (see
  // the `catch` block in `install-sniffer.ts`). The sniffer doesn't
  // know whether the failing fetch was a real cross-origin request from
  // the page or one of Tauri's own `ipc://` IPC fetches that WebKit's
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
  // Promise chain that serializes outbound emits — see the module
  // header for the IPC-fallback-ordering rationale.
  let emitChain: Promise<void> = Promise.resolve()

  const enqueueEmit = (eventName: string, payload?: unknown): Promise<void> => {
    emitChain = emitChain.then(() => eventBus.emit(eventName, payload)).catch(() => {})
    return emitChain
  }

  return {
    emit: (eventName, payload) => {
      if (eventName !== BRIDGE_EVENT) return enqueueEmit(eventName, payload)
      if (payload === null || typeof payload !== 'object') {
        return enqueueEmit(eventName, payload)
      }

      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const record = payload as Record<string, unknown>
      const tag = record._tag
      if (typeof tag !== 'string') return enqueueEmit(eventName, payload)

      if (tag === 'Log' && isWarnWithHeadPrefix(record, TAURI_IPC_FALLBACK_WARN_PREFIX)) {
        return Promise.resolve()
      }

      // Buffer the "fetch threw before response:" Log: install-sniffer
      // emits this Log synchronously right before the ResponseStart
      // carrying the failing URL. Decide whether to forward it on the
      // next event (see the drain below).
      if (tag === 'Log' && isWarnWithHeadPrefix(record, SNIFFER_FETCH_THREW_WARN_PREFIX)) {
        bufferedFetchErrorLog = record
        return Promise.resolve()
      }

      // Drain the buffered Log first, deciding by the *current* event:
      // if it's a ResponseStart for a Tauri-internal URL, the Log was
      // about a blocked IPC fetch — drop it; otherwise forward it so
      // real page-fetch errors stay visible. Any non-ResponseStart
      // event also forwards the Log (the lookahead pairing only holds
      // for sync ResponseStart immediately after the warning). The
      // forwarded Log goes through `enqueueEmit` so it stays ordered
      // with the next event in the chain.
      if (bufferedFetchErrorLog !== null) {
        const buffered = bufferedFetchErrorLog
        bufferedFetchErrorLog = null
        const isInternalResponseStart = tag === 'ResponseStart' && isTauriInternalUrl(record.url)
        if (!isInternalResponseStart) {
          void enqueueEmit(BRIDGE_EVENT, buffered)
        }
      }

      // Tag-time gate: record the id of any request whose start URL is
      // Tauri-internal so we can drop the per-chunk and terminal events
      // that follow without re-checking the URL (those events don't
      // carry one).
      if (tag === 'ResponseStart' && isTauriInternalUrl(record.url)) {
        if (typeof record.id === 'string') internalRequestIds.add(record.id)
        return Promise.resolve()
      }

      if (
        (tag === 'ResponseData' ||
          tag === 'ResponseFinished' ||
          tag === 'RequestError' ||
          tag === 'Cancelled') &&
        typeof record.id === 'string' &&
        internalRequestIds.has(record.id)
      ) {
        if (tag === 'ResponseFinished' || tag === 'RequestError' || tag === 'Cancelled') {
          // Terminal event — release the id so the set doesn't grow
          // unboundedly across the page's lifetime.
          internalRequestIds.delete(record.id)
        }
        return Promise.resolve()
      }

      return enqueueEmit(eventName, payload)
    },
    listen: eventBus.listen,
  }
}

export { makeFilteringEventBus }
