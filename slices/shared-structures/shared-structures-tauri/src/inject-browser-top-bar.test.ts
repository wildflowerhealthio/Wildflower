import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { injectBrowserTopBar } from './inject-browser-top-bar.ts'

// The bar's controls live inside a `closed` shadow root, so — like the sniffer's
// bootstrap test — external script can't reach the buttons. The observable
// contract is the host element, its closed shadow, idempotence, and the
// self-heal observer slot.

const HOST_ID = 'shared-structures-tauri-test-top-bar'
const OBSERVER_SLOT = Symbol.for('shared-structures-tauri:test-top-bar-observer')

const reset = (): void => {
  const observer: unknown = Reflect.get(globalThis, OBSERVER_SLOT)
  if (observer instanceof MutationObserver) observer.disconnect()
  Reflect.deleteProperty(globalThis, OBSERVER_SLOT)
  document.getElementById(HOST_ID)?.remove()
  document.documentElement.style.removeProperty('padding-top')
}

describe('injectBrowserTopBar', () => {
  beforeEach(reset)
  afterEach(reset)

  it('attaches a host element with a closed shadow root', () => {
    injectBrowserTopBar({
      hostId: HOST_ID,
      observerSlotKey: OBSERVER_SLOT,
      primary: 'back',
      showReload: true,
      onExit: () => {},
    })
    const host = document.getElementById(HOST_ID)
    expect(host).not.toBeNull()
    // `closed` shadow → `shadowRoot` is null externally.
    expect(host?.shadowRoot).toBeNull()
  })

  it('is idempotent for the same hostId', () => {
    injectBrowserTopBar({
      hostId: HOST_ID,
      observerSlotKey: OBSERVER_SLOT,
      primary: 'close',
      onExit: () => {},
    })
    injectBrowserTopBar({
      hostId: HOST_ID,
      observerSlotKey: OBSERVER_SLOT,
      primary: 'close',
      onExit: () => {},
    })
    expect(document.querySelectorAll(`#${HOST_ID}`).length).toBe(1)
  })

  it('stashes the self-heal observer in the provided slot', () => {
    injectBrowserTopBar({
      hostId: HOST_ID,
      observerSlotKey: OBSERVER_SLOT,
      primary: 'back',
      onExit: () => {},
    })
    expect(Reflect.get(globalThis, OBSERVER_SLOT)).toBeInstanceOf(MutationObserver)
  })

  it('re-attaches the host when a hostile page strips it (self-heal)', async () => {
    injectBrowserTopBar({
      hostId: HOST_ID,
      observerSlotKey: OBSERVER_SLOT,
      primary: 'back',
      onExit: () => {},
    })
    document.getElementById(HOST_ID)?.remove()
    // The MutationObserver fires on a microtask after the childList change.
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.getElementById(HOST_ID)).not.toBeNull()
  })
})
