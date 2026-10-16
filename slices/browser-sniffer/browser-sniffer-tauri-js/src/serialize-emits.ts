import type { TauriEventApi } from '@wildflowerhealthio/effect-messaging-tauri-js'

/**
 * Outbound wrapper for the sniffer's multiplexed `BRIDGE_EVENT` channel.
 * Wraps a {@link TauriEventApi} to serialize outbound emits on a Promise chain
 * (one in-flight at a time): Tauri's macOS IPC transport reorders emits issued
 * during its first `ipc://` → `WKScriptMessageHandler` fallback, scrambling a
 * streaming burst; the chain trades one round-trip per emit for FIFO. Rejected
 * emits are reported, not swallowed, and don't poison the chain.
 *
 * `listen` passes straight through.
 */

/**
 * Wrap a {@link TauriEventApi} so outbound emits are serialized (see this
 * module's header).
 *
 * @remarks The emit-chain Promise is per-wrapper closure state — one wrapper per
 * page; tests construct a fresh wrapper per case.
 */
const makeSerializedEventBus = (eventBus: TauriEventApi): TauriEventApi => {
  let emitChain: Promise<void> = Promise.resolve()

  // Capture console.error at construction, before page scripts can replace it:
  // a page override that fetches (sniffed → emit) would loop while the bridge
  // is failing, and one that throws would poison the chain.
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
    emit: enqueueEmit,
    // Arrow (not a bare reference) so the underlying bus stays the receiver.
    listen: (event, handler) => eventBus.listen(event, handler),
  }
}

export { makeSerializedEventBus }
