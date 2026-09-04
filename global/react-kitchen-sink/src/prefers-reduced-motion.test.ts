import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { prefersReducedMotion } from './prefers-reduced-motion.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stubs `matchMedia` to report the given `matches` for every query. */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string): Pick<MediaQueryList, 'matches' | 'media'> => ({
    matches,
    media: query,
  }))
}

describe('prefersReducedMotion', () => {
  it('should report true when the OS asks for reduced motion', () => {
    stubMatchMedia(true)
    expect(prefersReducedMotion()).toBe(true)
  })

  it('should report false when the OS does not ask for reduced motion', () => {
    stubMatchMedia(false)
    expect(prefersReducedMotion()).toBe(false)
  })

  it('should report false when matchMedia is unavailable', () => {
    // jsdom ships no `matchMedia`; the optional call must fall back to false
    // rather than throw.
    vi.stubGlobal('matchMedia', undefined)
    expect(prefersReducedMotion()).toBe(false)
  })
})
