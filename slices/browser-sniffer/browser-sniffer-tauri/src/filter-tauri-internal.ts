import type { TauriEventApi } from 'effect-messaging-tauri'

import { BRIDGE_EVENT } from './install-sniffer.ts'
import { isRecord } from './is-record.ts'

/**
 * Outbound wrapper for the sniffer's multiplexed `BRIDGE_EVENT` channel.
 * Wraps a {@link TauriEventApi} to:
 *
 *   1. Drop Tauri's own IPC-fallback `console.warn` ("IPC custom protocol
 *      failed …"), which the console shim would otherwise re-post as a
 *      `Log` once per IPC call — noise, not a page observation.
 *   2. Serialize outbound emits on a Promise chain (one in-flight at a
 *      time). Tauri's macOS IPC transport reorders emits issued during
 *      its first `ipc://` → `WKScriptMessageHandler` fallback, which would
 *      scramble a streaming burst; the chain trades one round-trip per
 *      emit for FIFO. Rejected emits are reported, not swallowed, and
 *      don't poison the chain (see {@link makeFilteringEventBus}).
 *
 * Tauri-internal IPC URLs are skipped at the shim source
 * (`install-sniffer.ts`'s `isTauriInternalUrl`), so they never reach here.
 * `listen` and non-`BRIDGE_EVENT` emits pass straight through.
 */

const TAURI_IPC_FALLBACK_WARN_PREFIX = 'IPC custom protocol failed'

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

  // Capture the *native* console.error before `installSniffer` swaps `console.*`
  // for Log-posting shims, so reporting a dropped emit can't re-enter
  // console → post(Log) → emit and loop when the bridge itself is failing.
  const reportDroppedEmit = globalThis.console.error.bind(globalThis.console)

  const enqueueEmit = (eventName: string, payload?: unknown): Promise<void> => {
    // `.catch` keeps the chain alive after a rejected emit while still surfacing
    // it: a poisoned chain would drop every later message, and a silently
    // dropped `ResponseData` chunk truncates the host's reassembly with no
    // diagnostic.
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
    // Arrow, not a bare method reference, so the underlying bus stays the
    // receiver if it ever implements `listen` as a `this`-bound method.
    listen: (event, handler) => eventBus.listen(event, handler),
  }
}

export { makeFilteringEventBus }
