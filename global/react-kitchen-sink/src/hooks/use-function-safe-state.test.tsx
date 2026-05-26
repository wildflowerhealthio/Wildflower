import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { useFunctionSafeState } from './use-function-safe-state.ts'

const increment = (n: number): number => n + 1
const sayHello = (): string => 'hello'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useFunctionSafeState', () => {
  it('should store a function as state and return it untouched', () => {
    // Arrange
    type Fn = (n: number) => number
    const fn: Fn = increment
    const { result } = renderHook(() => useFunctionSafeState<Fn | null>(null))

    // Act
    act(() => {
      const [, setFn] = result.current
      setFn(fn)
    })

    // Assert — the stored value IS the original function reference
    const [stored] = result.current
    expect(stored).toBe(fn)
    expect(stored?.(41)).toBe(42)
  })

  it('should accept null as the initial value and after a function has been set', () => {
    // Arrange
    type Fn = () => string
    const fn: Fn = sayHello
    const { result } = renderHook(() => useFunctionSafeState<Fn | null>(null))
    expect(result.current[0]).toBeNull()

    // Act — set then clear
    act(() => {
      const [, setFn] = result.current
      setFn(fn)
    })
    expect(result.current[0]).toBe(fn)
    act(() => {
      const [, setFn] = result.current
      setFn(null)
    })

    // Assert
    expect(result.current[0]).toBeNull()
  })

  it('should replace one function with another without invoking the previous one', () => {
    // Arrange
    type Fn = (n: number) => number
    const first = vi.fn<Fn>((n) => n * 2)
    const second = vi.fn<Fn>((n) => n + 100)
    const { result } = renderHook(() => useFunctionSafeState<Fn | null>(null))

    act(() => {
      const [, setFn] = result.current
      setFn(first)
    })
    expect(result.current[0]).toBe(first)

    // Act — replacing with `second`. If the setter were not using the
    // updater form, React would call `second(prev)` to compute the next
    // state. We verify it does NOT, and that the stored value is the
    // raw `second` reference.
    act(() => {
      const [, setFn] = result.current
      setFn(second)
    })

    // Assert
    const [stored] = result.current
    expect(stored).toBe(second)
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    // sanity: invoking the stored value reaches `second`
    expect(stored?.(1)).toBe(101)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('should keep the setter identity stable across renders', () => {
    // Arrange
    const { result, rerender } = renderHook(() => useFunctionSafeState<number>(0))
    const [, firstSetter] = result.current

    // Act
    rerender()
    const [, secondSetter] = result.current

    // Assert
    expect(secondSetter).toBe(firstSetter)
  })

  it('should also work for non-function values', () => {
    // Arrange
    const { result } = renderHook(() => useFunctionSafeState<number>(0))

    // Act
    act(() => {
      const [, setN] = result.current
      setN(7)
    })

    // Assert
    expect(result.current[0]).toBe(7)
  })
})
