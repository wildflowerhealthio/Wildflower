import { renderHook } from '@testing-library/react'
import { NoContextException } from 'react-kitchen-sink'
import { describe, expect, test, vi } from 'vite-plus/test'
import { makeOutlet } from './outlet.tsx'

const silenceReactErrorBoundary = (): (() => void) => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return (): void => {
    spy.mockRestore()
  }
}

describe('makeOutlet', () => {
  test('Provider has a `${name}Provider` displayName', () => {
    const { Provider } = makeOutlet('Navigate', 0)
    expect(Provider.displayName).toBe('NavigateProvider')
  })

  test('useValueRef reads the default before any register', () => {
    const outlet = makeOutlet('Greeting', 'hi')
    const { result } = renderHook(() => outlet.useValueRef(), {
      wrapper: ({ children }) => <outlet.Provider>{children}</outlet.Provider>,
    })
    expect(result.current.current).toBe('hi')
  })

  test('useRegister swaps the slot; last writer wins', () => {
    const outlet = makeOutlet('Counter', 0)
    const { result, rerender } = renderHook(
      ({ value }: { value: number }) => {
        outlet.useRegister(value)
        return outlet.useValueRef()
      },
      {
        wrapper: ({ children }) => <outlet.Provider>{children}</outlet.Provider>,
        initialProps: { value: 1 },
      }
    )
    expect(result.current.current).toBe(1)
    rerender({ value: 2 })
    expect(result.current.current).toBe(2)
  })

  test('useValueRef throws NoContextException outside the Provider', () => {
    const outlet = makeOutlet('Orphan', 0)
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(() => outlet.useValueRef())).toThrow(NoContextException)
    } finally {
      restore()
    }
  })
})
