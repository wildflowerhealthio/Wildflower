import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { useHref } from './use-href.ts'

afterEach(() => {
  cleanup()
  window.location.hash = ''
})

describe('useHref', () => {
  it('should return the current location href', () => {
    // Arrange / Act
    const { result } = renderHook(() => useHref())

    // Assert
    expect(result.current).toBe(window.location.href)
  })

  it('should update when a hashchange event fires', () => {
    // Arrange
    const { result } = renderHook(() => useHref())

    // Act
    act(() => {
      window.location.hash = '#test-hash'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    // Assert
    expect(result.current).toContain('#test-hash')
  })

  it('should update when a popstate event fires', () => {
    // Arrange
    const { result } = renderHook(() => useHref())
    const initialHref = result.current

    // Act
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    // Assert — popstate re-reads from location, so it should still be current
    expect(result.current).toBe(initialHref)
  })
})
