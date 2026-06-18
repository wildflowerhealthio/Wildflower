import type { TauriEventApi } from 'effect-messaging-tauri'

import { BRIDGE_EVENT } from './install-sniffer.ts'

/**
 * Outbound filter + serializer for the sniffer's multiplexed
 * `BRIDGE_EVENT` Tauri channel. Wraps a {@link TauriEventApi} so:
 *
 *   1. Tauri's own IPC-fallback `console.warn` ("IPC custom protocol
 *      failed …") — captured by the sniffer's console shim and re-posted
 *      as a `Log` — is dropped. It fires once per IPC call until WebKit's
 *      `customProtocolIpcFailed` flips sticky; the per-call spam is noise,
 *      not a page observation.
 *   2. Outbound emits are serialized on a Promise chain. Tauri's macOS
 *      IPC transport falls back from a blocked `ipc://` fetch to the
 *      `WKScriptMessageHandler` postMessage path on the first call, and
 *      emits issued concurrently during that transition were observed to
 *      reorder — so a streaming burst (`ResponseStart` + N×`ResponseData`
 *      + `ResponseFinished`) could land out of order on the host. The
 *      chain forces one in-flight emit at a time, at a cost of one IPC
 *      round-trip per emit, to keep the sniffer's chunked page-content
 *      stream FIFO. A rejected emit is reported (not swallowed) and does
 *      not poison the chain — see {@link makeFilteringEventBus}.
 *
 * Tauri-internal IPC traffic itself (`ipc://`, `tauri://localhost`, …) is
 * not filtered here: the fetch/XHR shims in `install-sniffer.ts` skip
 * those URLs at the source (see `isTauriInternalUrl`), so they never
 * reach this wrapper as `ResponseStart`/`ResponseData`/… in the first
 * place.
 *
 * `listen` and any emit whose name is not `BRIDGE_EVENT` pass through
 * (still on the chain, so ordering holds across event names).
 */

const TAURI_IPC_FALLBACK_WARN_PREFIX = 'IPC custom protocol failed'

/**
 * Narrow an unknown wire payload to a string-keyed record. A real type
 * guard (not an assertion), so reading `record._tag` / `record.level`
 * downstream stays type-safe without an `as` cast.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

/**
 * Whether `record` is the `warn`-level `Log` Tauri emits (via the
 * console shim) when its custom-protocol IPC fetch is blocked and it
 * falls back to postMessage.
 */
const isTauriIpcFallbackWarning = (record: Record<string, unknown>): boolean => {
  if (record.level !== 'warn') return false
  const payload = record.payload
  if (!Array.isArray(payload) || payload.length === 0) return false
  const head: unknown = payload[0]
  return typeof head === 'string' && head.startsWith(TAURI_IPC_FALLBACK_WARN_PREFIX)
}

/**
 * Wrap a {@link TauriEventApi} so outbound `BRIDGE_EVENT` emits are
 * serialized and the Tauri IPC-fallback warning is dropped (see this
 * module's header).
 *
 * Closure state (the outbound emit-chain Promise) lives on the wrapper
 * instance — one wrapper per page is the intended use; tests construct a
 * fresh wrapper per case.
 */
const makeFilteringEventBus = (eventBus: TauriEventApi): TauriEventApi => {
  let emitChain: Promise<void> = Promise.resolve()

  // Capture the *native* console.error now, before `installSniffer`
  // swaps `console.*` for the Log-posting shims. A dropped emit is
  // reported through this captured reference rather than the live
  // `console.error`, so surfacing the failure can't re-enter the
  // console → `post(Log)` → `emit` path and loop when the bridge itself
  // is the thing that's failing.
  const reportDroppedEmit = globalThis.console.error.bind(globalThis.console)

  const enqueueEmit = (eventName: string, payload?: unknown): Promise<void> => {
    // `.catch` keeps the chain alive after a rejected emit (a poisoned
    // chain would silently drop every later message), but the failure is
    // surfaced rather than swallowed: a dropped `ResponseData` chunk
    // otherwise leaves the host reassembling a truncated body with no
    // diagnostic anywhere.
    emitChain = emitChain
      .then(() => eventBus.emit(eventName, payload))
      .catch((error: unknown) => {
        reportDroppedEmit(`[browser-sniffer] bridge emit dropped (${eventName}): ${String(error)}`)
      })
    return emitChain
  }

  return {
    emit: (eventName, payload) => {
      // Only the multiplexed bridge channel carries the `Log` payloads we
      // filter; everything else just rides the ordering chain.
      if (eventName === BRIDGE_EVENT && isRecord(payload)) {
        if (payload._tag === 'Log' && isTauriIpcFallbackWarning(payload)) {
          return Promise.resolve()
        }
      }
      return enqueueEmit(eventName, payload)
    },
    // Forward through an arrow (not a bare method reference) so the
    // underlying bus stays the receiver — symmetric with `emit` above and
    // safe if a wrapped bus ever implements `listen` as a `this`-bound
    // method.
    listen: (event, handler) => eventBus.listen(event, handler),
  }
}

export { makeFilteringEventBus }
