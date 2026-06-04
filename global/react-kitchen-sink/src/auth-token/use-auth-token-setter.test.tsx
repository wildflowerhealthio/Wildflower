import { renderHook } from '@testing-library/react'
import { Effect, SubscriptionRef } from 'effect'
import type { JSX, ReactNode } from 'react'
import { describe, expect, test, vi } from 'vite-plus/test'

import { NoContextException } from '../hooks/use-context-or-throw.ts'
import { AuthTokenProvider } from './auth-token-provider.tsx'
import type { AuthTokenStore } from './auth-token-store.ts'
import { useAuthTokenSetter } from './use-auth-token-setter.ts'

/**
 * Build a minimal in-memory {@link AuthTokenStore} backed by a
 * `SubscriptionRef`. Generic to react-kitchen-sink — no slice-specific
 * factory (those live in app-side packages) is pulled in.
 */
const makeFakeStore = (): AuthTokenStore => {
  const ref = Effect.runSync(SubscriptionRef.make<string | null>(null))
  return {
    subscribable: ref,
    setToken: (token) => {
      Effect.runSync(SubscriptionRef.set(ref, token))
    },
  }
}

const silenceReactErrorBoundary = (): (() => void) => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return (): void => {
    spy.mockRestore()
  }
}

describe('useAuthTokenSetter', () => {
  test("returns the store's setToken when wrapped in <AuthTokenProvider>", () => {
    const store = makeFakeStore()
    const { result } = renderHook(useAuthTokenSetter, {
      wrapper: ({ children }: { readonly children: ReactNode }): JSX.Element => (
        <AuthTokenProvider store={store}>{children}</AuthTokenProvider>
      ),
    })
    expect(result.current).toBe(store.setToken)
  })

  test('throws when rendered without <AuthTokenProvider>', () => {
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(useAuthTokenSetter)).toThrow(NoContextException)
    } finally {
      restore()
    }
  })
})
