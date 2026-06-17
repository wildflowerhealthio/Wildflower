// oxlint-disable typescript/no-implied-eval -- intentional sandbox eval of the bundled IIFE bootstrap; the whole point of the test is to run that IIFE in a controlled fake-window environment.

import { BrowserSnifferBridge } from 'browser-sniffer-core/bridge'
import { describe, expect, it } from 'vite-plus/test'

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

/**
 * Evaluate the IIFE bootstrap in a fresh jsdom-backed window with a
 * fake `__TAURI__.event` API attached. Returns the emits the bootstrap
 * (and the wrapped sniffer) made plus a function to feed inbound Tauri
 * events at the bootstrap's listeners.
 *
 * The bootstrap installs `installSniffer()` which immediately posts
 * `{_tag: '__Ready'}` via `window.ReactNativeWebView.postMessage` — so
 * a successful boot is observable as a `bridge:__Ready` emit in
 * `emits`.
 */
const bootBootstrapInFreshWindow = (
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

  Object.defineProperty(globalThis, '__TAURI__', {
    configurable: true,
    writable: true,
    value: options.withTauri ? { event: fakeEvent } : undefined,
  })

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
    const { emits } = bootBootstrapInFreshWindow()
    const ready = emits.find((entry) => entry.event === 'bridge:__Ready')
    expect(ready).toBeDefined()
    expect(ready?.payload).toMatchObject({ _tag: '__Ready' })
  })

  it('forwards a sniffer postMessage as a structured Tauri event', () => {
    const { emits } = bootBootstrapInFreshWindow()
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
    const { fireInbound } = bootBootstrapInFreshWindow()
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

  it('does nothing observable when window.__TAURI__ is absent (the shim becomes a no-op)', () => {
    // Without __TAURI__, the bootstrap skips the shim install entirely.
    // installSniffer() still runs but its `post()` helper short-circuits
    // because `window.ReactNativeWebView` is undefined — so no emits
    // happen via the (also-absent) fake event API.
    const { emits } = bootBootstrapInFreshWindow({ withTauri: false })
    expect(emits).toHaveLength(0)
  })
})
