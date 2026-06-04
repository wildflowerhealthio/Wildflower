import fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { addOsColorSchemeListener } from './add-os-color-scheme-listener.ts'

/**
 * Install a controllable fake `window.matchMedia`. The returned
 * `dispatchChange` flips the query's `matches` and fires every registered
 * `change` listener, standing in for the OS preference toggling. `listeners`
 * is exposed so a test can assert that unsubscribing actually detaches.
 */
const installMatchMedia = (
  initialMatches: boolean
): { dispatchChange: (matches: boolean) => void; listeners: Set<() => void> } => {
  const state = { matches: initialMatches }
  const listeners = new Set<() => void>()
  const query = {
    get matches() {
      return state.matches
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener)
    },
  }
  vi.stubGlobal('matchMedia', () => query)
  return {
    listeners,
    dispatchChange: (matches: boolean) => {
      state.matches = matches
      for (const listener of listeners) listener()
    },
  }
}

const currentScheme = (): string | null =>
  document.documentElement.getAttribute('data-color-scheme')

describe('addOsColorSchemeListener', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.colorScheme
  })

  test('applies dark immediately when the OS prefers dark', () => {
    installMatchMedia(true)
    addOsColorSchemeListener()
    expect(currentScheme()).toBe('dark')
  })

  test('applies light immediately when the OS does not prefer dark', () => {
    installMatchMedia(false)
    addOsColorSchemeListener()
    expect(currentScheme()).toBe('light')
  })

  test('reflects a later preference change onto the attribute', () => {
    const { dispatchChange } = installMatchMedia(false)
    addOsColorSchemeListener()
    dispatchChange(true)
    expect(currentScheme()).toBe('dark')
  })

  test('stops updating and detaches its listener after unsubscribe', () => {
    const { dispatchChange, listeners } = installMatchMedia(false)
    const unsubscribe = addOsColorSchemeListener()
    unsubscribe()
    expect(listeners.size).toBe(0)
    dispatchChange(true)
    expect(currentScheme()).toBe('light')
  })

  test('the attribute always tracks the latest preference across a sequence of changes', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.array(fc.boolean()), (initial, changes) => {
        const { dispatchChange } = installMatchMedia(initial)
        const unsubscribe = addOsColorSchemeListener()
        expect(currentScheme()).toBe(initial ? 'dark' : 'light')
        for (const matches of changes) {
          dispatchChange(matches)
          expect(currentScheme()).toBe(matches ? 'dark' : 'light')
        }
        unsubscribe()
        vi.unstubAllGlobals()
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
