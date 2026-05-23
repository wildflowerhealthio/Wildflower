import { renderHook } from '@testing-library/react'
import { createContext, type JSX, type ReactNode } from 'react'
import { describe, expect, test, vi } from 'vite-plus/test'

import { NoContextException, useContextOrThrow } from './use-context-or-throw.ts'

interface Value {
  readonly id: string
}

const TestContext = createContext<Value | null>(null)
TestContext.displayName = 'TestContext'

const useTestContext = (): Value => useContextOrThrow(TestContext)

const Wrapper = ({
  value,
  children,
}: {
  readonly value: Value
  readonly children: ReactNode
}): JSX.Element => <TestContext.Provider value={value}>{children}</TestContext.Provider>

const silenceReactErrorBoundary = (): (() => void) => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return (): void => {
    spy.mockRestore()
  }
}

describe('useContextOrThrow', () => {
  test('returns the value when a provider is mounted', () => {
    const value: Value = { id: 'present' }
    const { result } = renderHook(useTestContext, {
      wrapper: ({ children }) => <Wrapper value={value}>{children}</Wrapper>,
    })
    expect(result.current).toBe(value)
  })

  test('throws NoContextException carrying the context displayName when no provider is mounted', () => {
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(useTestContext)).toThrow(NoContextException)
      expect(() => renderHook(useTestContext)).toThrow(/TestContext must be used inside/)
    } finally {
      restore()
    }
  })

  test('falls back to "context" when displayName is unset', () => {
    const Anon = createContext<Value | null>(null)
    const useAnon = (): Value => useContextOrThrow(Anon)
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(useAnon)).toThrow(/context must be used inside/)
    } finally {
      restore()
    }
  })
})
