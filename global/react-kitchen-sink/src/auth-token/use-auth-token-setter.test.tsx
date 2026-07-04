import { renderHook } from '@testing-library/react'
import { Effect, SubscriptionRef } from 'effect'
import type { JSX, ReactNode } from 'react'
import { describe, expect, test, vi } from 'vite-plus/test'

import { NoContextException } from '../hooks/use-context-or-throw.ts'
import { type AuthSignal, Unauthed } from './auth-signal.ts'
import { AuthTokenProvider } from './auth-token-provider.tsx'
import type { AuthTokenStore } from './auth-token-store.ts'
import { useAuthTokenSetter } from './use-auth-token-setter.ts'

/**
 * Build a minimal in-memory {@link AuthTokenStore} backed by a
 * `SubscriptionRef`. Generic to react-kitchen-sink — no slice-specific
 * factory (those live in app-side packages) is pulled in.
 */
const makeFakeStore = (): AuthTokenStore => {
  const ref = Effect.runSync(SubscriptionRef.make<AuthSignal>(Unauthed()))
  return {
    subscribable: ref,
    setSignal: (signal) => {
      Effect.runSync(SubscriptionRef.set(ref, signal))
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
  test("returns the store's setSignal when wrapped in <AuthTokenProvider>", () => {
    const store = makeFakeStore()
    const { result } = renderHook(useAuthTokenSetter, {
      wrapper: ({ children }: { readonly children: ReactNode }): JSX.Element => (
        <AuthTokenProvider store={store}>{children}</AuthTokenProvider>
      ),
    })
    expect(result.current).toBe(store.setSignal)
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
