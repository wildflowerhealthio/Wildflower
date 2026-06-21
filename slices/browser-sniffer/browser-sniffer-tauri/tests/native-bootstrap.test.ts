// oxlint-disable typescript/no-implied-eval -- intentional sandbox eval of the bundled IIFE bootstrap; the whole point is to run that IIFE in a controlled fake-window environment.

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { nativeSnifferBootstrapScript } from '../src/index.ts'

const SNIFFER_STATE_SLOT = Symbol.for('browser-sniffer:state')
const BROWSER_TOP_BAR_HOST_ID = 'wildflower-sniffer-browser-top-bar'

type BridgeGlobals = typeof globalThis & {
  webkit?: { messageHandlers?: { nativeWebview?: { postMessage: (message: string) => void } } }
  nativeWebview?: { postMessage: (message: string) => void }
  __nativeWebviewReceive?: (json: string) => void
}
const globals = globalThis as BridgeGlobals

const reset = (): void => {
  Reflect.deleteProperty(globalThis, SNIFFER_STATE_SLOT)
  delete globals.webkit
  delete globals.nativeWebview
  // oxlint-disable-next-line no-underscore-dangle -- the native plugin calls this exact global.
  delete globals.__nativeWebviewReceive
}

beforeEach(reset)
afterEach(reset)

// The bundled IIFE reads `globalThis` bridges; running via `Function('...')()`
// keeps it out of the module's eval scope so its `globalThis` references resolve
// to jsdom's window.
const boot = (): void => {
  new Function(nativeSnifferBootstrapScript)()
}

describe('nativeSnifferBootstrapScript', () => {
  it('is at least 1KB — guards against a stale or empty generated file', () => {
    expect(nativeSnifferBootstrapScript.length).toBeGreaterThan(1000)
  })

  it('installs the sniffer over the native bridge when a handler is present', () => {
    const posted: string[] = []
    globals.webkit = {
      messageHandlers: { nativeWebview: { postMessage: (message) => posted.push(message) } },
    }

    boot()

    // installSniffer ran: its symbol-keyed state slot exists.
    expect(SNIFFER_STATE_SLOT in (globalThis as object)).toBe(true)
    // The native toolbar replaces the in-page chrome — no BrowserTopBar host.
    expect(document.getElementById(BROWSER_TOP_BAR_HOST_ID)).toBeNull()
    // installSniffer posts a single-shot diagnostic Log on install, proving the
    // bridge transport carries sniffer output. Everything posted is a valid
    // bridge envelope `{ event: 'bridge', payload: { _tag } }`.
    expect(posted.length).toBeGreaterThan(0)
    for (const raw of posted) {
      const envelope: unknown = JSON.parse(raw)
      expect(envelope).toMatchObject({ event: 'bridge' })
    }
  })

  it('no-ops when no native bridge is present', () => {
    boot()
    expect(SNIFFER_STATE_SLOT in (globalThis as object)).toBe(false)
    expect(document.getElementById(BROWSER_TOP_BAR_HOST_ID)).toBeNull()
  })
})
