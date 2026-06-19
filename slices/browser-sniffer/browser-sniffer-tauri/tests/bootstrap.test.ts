// oxlint-disable typescript/no-implied-eval -- intentional sandbox eval of the bundled IIFE bootstrap; the whole point of the test is to run that IIFE in a controlled fake-window environment.

import { BrowserSnifferBridge } from 'browser-sniffer-core/bridge'
import type { TauriEventApi } from 'effect-messaging-tauri'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { tauriSnifferBootstrapScript } from '../src/index.ts'

/**
 * Multiplexed bridge channel literal — pinned in
 * `effect-messaging-tauri/event-names.ts` and the sniffer's own copy in
 * `install-sniffer.ts`. Hardcoded here rather than imported so the
 * bootstrap's own copy can drift independently and the test catches it.
 */
const BRIDGE_EVENT = 'bridge'

interface EventListenEnvelope {
  readonly payload: unknown
}

const SNIFFER_STATE_SLOT = Symbol.for('browser-sniffer:state')
const TOP_BAR_OBSERVER_SLOT = Symbol.for('browser-sniffer-tauri:top-bar-observer')
const TAURI_GLOBAL_SLOT = '__TAURI__'
const BROWSER_TOP_BAR_HOST_ID = 'wildflower-sniffer-browser-top-bar'

/**
 * Reset globalThis state that the bootstrap or `installSniffer()` writes
 * to. Tests in this file share a single jsdom window — without this,
 * `installSniffer()`'s symbol-slot idempotence check would short-circuit
 * the second test onward, and the previous test's `__TAURI__` fake would
 * leak into the next.
 */
const resetSnifferGlobals = (): void => {
  Reflect.deleteProperty(globalThis, TAURI_GLOBAL_SLOT)
  // Symbol-keyed slot installed by `installSniffer()` to short-circuit
  // a second install on the same page; clearing it lets the next test
  // re-shim fetch/XHR/console cleanly.
  Reflect.deleteProperty(globalThis, SNIFFER_STATE_SLOT)
  // Disconnect the BrowserTopBar's self-heal MutationObserver before
  // removing the host element — otherwise the observer would fire on
  // the removal and re-attach a fresh host immediately, leaking the
  // previous test's `eventBus` closure into the next test.
  const observerRaw: unknown = Reflect.get(globalThis, TOP_BAR_OBSERVER_SLOT)
  if (observerRaw instanceof MutationObserver) observerRaw.disconnect()
  Reflect.deleteProperty(globalThis, TOP_BAR_OBSERVER_SLOT)
  document.getElementById(BROWSER_TOP_BAR_HOST_ID)?.remove()
}

/**
 * Evaluate the IIFE bootstrap with a fake `__TAURI__.event` API attached
 * (or no `__TAURI__` at all, per options). Returns the emits the
 * bootstrap (and the wrapped sniffer) made plus a function to feed
 * inbound Tauri events at the bootstrap's listeners.
 */
const bootBootstrap = (
  options: { withTauri: boolean } = { withTauri: true }
): {
  emits: Array<{ event: string; payload: unknown }>
  fireInbound: (event: string, payload: unknown) => void
} => {
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

  if (options.withTauri) {
    Object.defineProperty(globalThis, TAURI_GLOBAL_SLOT, {
      configurable: true,
      writable: true,
      value: { event: fakeEvent },
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
    // Adding a third hostToWeb tag to BrowserSnifferBridge without
    // teaching `installSniffer` to listen for it would silently drop
    // those messages on the floor.
    const declared = Object.keys(BrowserSnifferBridge.HostToWeb).toSorted()
    expect(declared).toEqual(['CancelSnifferRequest', 'Click'])
  })

  it('attaches a BrowserTopBar host element on boot', () => {
    const { emits } = bootBootstrap()
    const host = document.getElementById(BROWSER_TOP_BAR_HOST_ID)
    expect(host).not.toBeNull()
    // Shadow is `closed`, so `host.shadowRoot` is null externally. The
    // user-visible contract is that the host exists; the Close button
    // wiring lives inside the closed shadow tree where external script
    // can't reach. Assert no spurious SniffingComplete fired on boot —
    // that would be the most obvious regression.
    expect(host?.shadowRoot).toBeNull()
    const completedOnBoot = emits.find(
      (entry) =>
        entry.event === BRIDGE_EVENT &&
        entry.payload !== null &&
        typeof entry.payload === 'object' &&
        '_tag' in entry.payload &&
        (entry.payload as { _tag: unknown })._tag === 'SniffingComplete'
    )
    expect(completedOnBoot, 'no SniffingComplete on boot').toBeUndefined()
  })

  it('skips installSniffer when window.__TAURI__ is absent', () => {
    // Without __TAURI__, the bootstrap does nothing — no BrowserTopBar
    // attaches, no symbol-keyed sniffer state slot is created.
    bootBootstrap({ withTauri: false })
    expect(document.getElementById(BROWSER_TOP_BAR_HOST_ID)).toBeNull()
    const stateSlotPresent = SNIFFER_STATE_SLOT in (globalThis as object)
    expect(stateSlotPresent).toBe(false)
  })
})
