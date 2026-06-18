// oxlint-disable typescript/no-implied-eval -- intentional sandbox eval of the bundled IIFE bootstrap; the whole point of the test is to run that IIFE in a controlled fake-window environment.

import { BrowserSnifferBridge } from 'browser-sniffer-core/bridge'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { tauriSnifferBootstrapScript } from '../src/index.ts'

interface EventListenEnvelope {
  readonly payload: unknown
}

interface FakeTauriEventApi {
  readonly emit: (event: string, payload?: unknown) => Promise<void>
  readonly listen: (
    event: string,
    handler: (event: EventListenEnvelope) => void
  ) => Promise<() => void>
}

interface WindowWithReactNativeWebView {
  ReactNativeWebView?: { postMessage(data: string): void }
}

const SNIFFER_STATE_SLOT = Symbol.for('browser-sniffer:state')
const UNLISTEN_SLOT = Symbol.for('browser-sniffer-tauri:unlisten')
const TAURI_GLOBAL_SLOT = '__TAURI__'
const RN_WEBVIEW_SLOT = 'ReactNativeWebView'
const BROWSER_TOP_BAR_HOST_ID = 'wildflower-sniffer-browser-top-bar'

/**
 * Reset globalThis state that the bootstrap or `installSniffer()` writes
 * to. Tests in this file share a single jsdom window — without this,
 * `installSniffer()`'s symbol-slot idempotence check would short-circuit
 * the second test onward, and a stale `ReactNativeWebView` shim left
 * over from a prior test could silently absorb posts that the current
 * test expects to observe (or, worse, expects to *not* happen).
 */
const resetSnifferGlobals = (): void => {
  // `Reflect.deleteProperty` lets us drop runtime-installed slots from
  // `globalThis` without a narrowing cast (TS treats `globalThis` as the
  // open Window type; asserting a narrower shape trips the
  // `no-unsafe-type-assertion` lint).
  Reflect.deleteProperty(globalThis, TAURI_GLOBAL_SLOT)
  Reflect.deleteProperty(globalThis, RN_WEBVIEW_SLOT)
  Reflect.deleteProperty(globalThis, UNLISTEN_SLOT)
  // Symbol-keyed slot installed by `installSniffer()` to short-circuit
  // a second install on the same page; clearing it lets the next test
  // re-shim fetch/XHR/console cleanly.
  Reflect.deleteProperty(globalThis, SNIFFER_STATE_SLOT)
  // Remove the BrowserTopBar host so the next test re-runs
  // `injectBrowserTopBar` against its own `eventBus` closure (the Close
  // button captures `eventBus` at attach time — without this, a leftover
  // host's button would emit into a prior test's recorded emits array).
  document.getElementById(BROWSER_TOP_BAR_HOST_ID)?.remove()
}

/**
 * Evaluate the IIFE bootstrap with a fake `__TAURI__.event` API attached
 * (or no `__TAURI__` at all, per options). Returns the emits the
 * bootstrap (and the wrapped sniffer) made plus a function to feed
 * inbound Tauri events at the bootstrap's listeners.
 *
 * The bootstrap installs `installSniffer()` which immediately posts
 * `{_tag: '__Ready'}` via `window.ReactNativeWebView.postMessage` — so
 * a successful boot is observable as a `bridge:__Ready` emit in
 * `emits`. Per-test global cleanup runs in `beforeEach`/`afterEach`
 * so emits, listeners, and the symbol-keyed sniffer state slot start
 * fresh.
 */
const bootBootstrap = (
  options: { withTauri: boolean } = { withTauri: true }
): {
  emits: Array<{ event: string; payload: unknown }>
  fireInbound: (event: string, payload: unknown) => void
} => {
  const emits: Array<{ event: string; payload: unknown }> = []
  const listeners = new Map<string, (event: EventListenEnvelope) => void>()
  const fakeEvent: FakeTauriEventApi = {
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

  // The bundled IIFE attaches `window.ReactNativeWebView` and starts
  // listening. Running it via `Function('...')()` keeps it out of the
  // module's eval scope so the shim's `globalThis` references resolve
  // to jsdom's window.
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
    // teaching the bootstrap to listen for it would silently drop those
    // messages on the floor — a near-impossible bug to track down
    // without this guard.
    const declared = Object.keys(BrowserSnifferBridge.HostToWeb).toSorted()
    expect(declared).toEqual(['CancelSnifferRequest', 'Click'])
  })

  it('emits bridge:__Ready when the sniffer initialises', () => {
    const { emits } = bootBootstrap()
    const ready = emits.find((entry) => entry.event === 'bridge:__Ready')
    expect(ready).toBeDefined()
    expect(ready?.payload).toMatchObject({ _tag: '__Ready' })
  })

  it('forwards a sniffer postMessage as a structured Tauri event', () => {
    const { emits } = bootBootstrap()
    // Simulate the sniffer posting a real wire message — the shim must
    // JSON-parse and re-emit on `bridge:ResponseStart` with the same
    // payload (modulo JSON round-trip).
    const wire = {
      _tag: 'ResponseStart',
      id: 'abc123',
      url: 'https://example.test/x',
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'text/plain']],
    }
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the bootstrap installed `ReactNativeWebView` on globalThis at runtime; the assertion makes that runtime addition visible to the type system.
    const winExt = globalThis as unknown as WindowWithReactNativeWebView
    const reactNativeWebView = winExt.ReactNativeWebView
    expect(reactNativeWebView).toBeDefined()
    // oxlint-disable-next-line eslint-plugin-unicorn/require-post-message-target-origin -- `ReactNativeWebView.postMessage(string)` is not the window `postMessage` API; no `targetOrigin` argument exists.
    reactNativeWebView?.postMessage(JSON.stringify(wire))

    const start = emits.find((entry) => entry.event === 'bridge:ResponseStart')
    expect(start).toBeDefined()
    expect(start?.payload).toEqual(wire)
  })

  it('delivers an inbound Tauri Click event as a window message with source=null', () => {
    const { fireInbound } = bootBootstrap()
    const received: Array<{ data: unknown; source: unknown }> = []
    const messageHandler = (event: MessageEvent): void => {
      received.push({ data: event.data, source: event.source })
    }
    globalThis.addEventListener('message', messageHandler)

    fireInbound('bridge:Click', { _tag: 'Click', querySelector: '#submit' })

    expect(received).toHaveLength(1)
    expect(received[0]?.source).toBeNull()
    expect(typeof received[0]?.data).toBe('string')
    const parsedData: unknown = JSON.parse(String(received[0]?.data))
    expect(parsedData).toEqual({
      _tag: 'Click',
      querySelector: '#submit',
    })

    globalThis.removeEventListener('message', messageHandler)
  })

  it('does nothing observable when window.__TAURI__ is absent (the shim is skipped end-to-end)', () => {
    // Without __TAURI__, the bootstrap skips the shim install AND skips
    // installSniffer(). Verified by checking that no ReactNativeWebView
    // got installed (so even if a downstream caller tried to post, it
    // would no-op) and that the sniffer state symbol slot is empty.
    bootBootstrap({ withTauri: false })
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- assertion exposes the optional runtime slot.
    const winExt = globalThis as unknown as WindowWithReactNativeWebView
    expect(winExt.ReactNativeWebView).toBeUndefined()
    const stateSlotPresent = SNIFFER_STATE_SLOT in (globalThis as object)
    expect(stateSlotPresent).toBe(false)
  })

  it('attaches a BrowserTopBar host element on boot', () => {
    const { emits } = bootBootstrap()
    const host = document.getElementById(BROWSER_TOP_BAR_HOST_ID)
    expect(host).not.toBeNull()
    // Shadow is `closed`, so `host.shadowRoot` is null externally. The
    // user-visible contract is that the host exists; the Close button
    // wiring lives inside the closed shadow tree where external script
    // can't reach. We assert no spurious SniffingComplete fired on boot
    // — that would be the most obvious regression.
    expect(host?.shadowRoot).toBeNull()
    const completedOnBoot = emits.find((entry) => entry.event === 'bridge:SniffingComplete')
    expect(completedOnBoot, 'no SniffingComplete on boot').toBeUndefined()
  })

  it('drains the Symbol-keyed unlisten slot from a prior run before re-registering', () => {
    // Simulate a previous bootstrap leaving an unlisten in the slot.
    let firstUnlistenCalled = false
    Object.defineProperty(globalThis, UNLISTEN_SLOT, {
      configurable: true,
      writable: true,
      value: [
        (): void => {
          firstUnlistenCalled = true
        },
      ],
    })

    bootBootstrap()

    // The drain is scheduled via Promise.resolve(...).then(...) so it
    // runs on the next microtask. await a flush.
    return Promise.resolve().then(() => {
      expect(firstUnlistenCalled).toBe(true)
    })
  })
})
