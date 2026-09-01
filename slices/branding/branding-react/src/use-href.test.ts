import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { useHref } from './use-href.ts'

afterEach(() => {
  cleanup()
  history.replaceState(null, '', window.location.pathname)
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

    // Act
    act(() => {
      history.pushState(null, '', '#via-popstate')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    // Assert
    expect(result.current).toContain('#via-popstate')
  })

  it('should unsubscribe both listeners on unmount', () => {
    // Arrange
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useHref())

    // Act
    unmount()

    // Assert
    const removedEvents = removeSpy.mock.calls.map((call) => call[0])
    expect(removedEvents).toContain('popstate')
    expect(removedEvents).toContain('hashchange')

    removeSpy.mockRestore()
  })
})
