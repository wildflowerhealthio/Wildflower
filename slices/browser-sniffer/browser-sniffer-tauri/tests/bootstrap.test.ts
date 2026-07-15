// oxlint-disable typescript/no-implied-eval -- intentional sandbox eval of the bundled IIFE bootstrap; the whole point of the test is to run that IIFE in a controlled fake-window environment.

import { BrowserSnifferBridge } from 'browser-sniffer-core/bridge'
import type { TauriEventApi } from 'effect-messaging-tauri'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { tauriSnifferBootstrapScript } from '../src/index.ts'

/**
 * Multiplexed bridge channel literal — pinned in
 * `effect-messaging-tauri/event-names.ts` and the sniffer's own copy in
 * `install-sniffer.ts`. Hardcoded rather than imported so the bootstrap's own
 * copy can drift independently and the test catches it.
 */
const BRIDGE_EVENT = 'bridge'

/**
 * Gated host command the desktop bootstrap routes outbound data-plane emits
 * through instead of `event.emit`. Hardcoded — like {@link BRIDGE_EVENT} — to
 * catch drift in the bootstrap's own copy.
 */
const DATA_PLANE_EMIT_COMMAND = 'native_webview_data_plane_emit'

interface EventListenEnvelope {
  readonly payload: unknown
}

const SNIFFER_STATE_SLOT = Symbol.for('browser-sniffer:state')
const TAURI_GLOBAL_SLOT = '__TAURI__'

/**
 * Reset globalThis state that the bootstrap or `installSniffer()` writes
 * to. Tests in this file share a single jsdom window — without this,
 * `installSniffer()`'s symbol-slot idempotence check would short-circuit
 * the second test onward, and the previous test's `__TAURI__` fake would
 * leak into the next.
 */
const resetSnifferGlobals = (): void => {
  Reflect.deleteProperty(globalThis, TAURI_GLOBAL_SLOT)
  Reflect.deleteProperty(globalThis, SNIFFER_STATE_SLOT)
}

/**
 * Evaluate the IIFE bootstrap with a fake `__TAURI__` (`event` + `core.invoke`)
 * attached (or no `__TAURI__` at all, per options). Returns the emits the
 * bootstrap (and the wrapped sniffer) made plus a function to feed inbound Tauri
 * events at the bootstrap's listeners.
 *
 * Outbound data-plane goes through `core.invoke(DATA_PLANE_EMIT_COMMAND, …)`
 * (not `event.emit`), so the fake `invoke` is what captures `emits`; inbound
 * still rides `event.listen`.
 */
const bootBootstrap = (
  options: { withTauri?: boolean; withCore?: boolean } = {}
): {
  emits: Array<{ event: string; payload: unknown }>
  fireInbound: (event: string, payload: unknown) => void
} => {
  const { withTauri = true, withCore = true } = options
  const emits: Array<{ event: string; payload: unknown }> = []
  const listeners = new Map<string, (event: EventListenEnvelope) => void>()
  const fakeEvent: TauriEventApi = {
    emit: async (event, payload): Promise<void> => {
      emits.push({ event, payload })
    },
    listen: async (event, handler): Promise<() => void> => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
  }
  const fakeInvoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    // The gated data-plane command re-broadcasts its `payload` on BRIDGE_EVENT
    // host-side; mirror that here so emits read the same as the old direct path.
    if (command === DATA_PLANE_EMIT_COMMAND) {
      emits.push({ event: BRIDGE_EVENT, payload: args?.payload })
    }
    return undefined
  }

  if (withTauri) {
    Object.defineProperty(globalThis, TAURI_GLOBAL_SLOT, {
      configurable: true,
      writable: true,
      value: withCore ? { event: fakeEvent, core: { invoke: fakeInvoke } } : { event: fakeEvent },
    })
  }

  // The bundled IIFE reads `globalThis.__TAURI__.event`. Running it via
  // `Function('...')()` keeps it out of the module's eval scope so the
  // shim's `globalThis` references resolve to jsdom's window.
  new Function(tauriSnifferBootstrapScript)()

  return {
    emits,
    fireInbound: (event, payload): void => {
      const handler = listeners.get(event)
      expect(handler, `no Tauri listener registered for ${event}`).toBeDefined()
      handler?.({ payload })
    },
  }
}

describe('tauriSnifferBootstrapScript', () => {
  beforeEach(() => {
    resetSnifferGlobals()
  })
  afterEach(() => {
    resetSnifferGlobals()
  })

  it('is at least 1KB — guards against a stale or empty generated file', () => {
    expect(tauriSnifferBootstrapScript.length).toBeGreaterThan(1000)
  })

  it('inbound tag set matches BrowserSnifferBridge.hostToWeb (drift guard)', () => {
    // Adding a hostToWeb tag to BrowserSnifferBridge without teaching
    // `installSniffer` to listen for it would silently drop those
    // messages on the floor.
    const declared = Object.keys(BrowserSnifferBridge.HostToWeb).toSorted()
    expect(declared).toEqual(['CancelSnifferRequest', 'Click', 'Fill'])
  })

  it('installs the sniffer when window.__TAURI__ event + core.invoke are present', () => {
    const { emits } = bootBootstrap()
    expect(SNIFFER_STATE_SLOT in (globalThis as object)).toBe(true)
    // No `SniffingComplete` on boot: it's the terminal close signal, now owned
    // by the plugin's chrome (pre-multi-webview, the in-page top bar emitted it).
    const completedOnBoot = emits.find(
      (entry) =>
        entry.event === BRIDGE_EVENT &&
        entry.payload !== null &&
        typeof entry.payload === 'object' &&
        '_tag' in entry.payload &&
        entry.payload._tag === 'SniffingComplete'
    )
    expect(completedOnBoot, 'no SniffingComplete on boot').toBeUndefined()
  })

  it('skips installSniffer when window.__TAURI__ is absent', () => {
    // Without __TAURI__ there's no event bus to ride; the bootstrap no-ops
    // rather than shimming fetch/XHR/console with nowhere to emit them.
    bootBootstrap({ withTauri: false })
    const stateSlotPresent = SNIFFER_STATE_SLOT in (globalThis as object)
    expect(stateSlotPresent).toBe(false)
  })

  it('skips installSniffer when core.invoke is absent (no data-plane transport)', () => {
    // The desktop sniffer's outbound data plane rides `core.invoke`, not
    // `event.emit`; with `event` but no `core` there's no emit path, so the
    // bootstrap no-ops rather than shimming with nowhere to send observations.
    bootBootstrap({ withCore: false })
    expect(SNIFFER_STATE_SLOT in (globalThis as object)).toBe(false)
  })
})
