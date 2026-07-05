import { renderHook } from '@testing-library/react'
import { Effect, SubscriptionRef } from 'effect'
import type { JSX, ReactNode } from 'react'
import { describe, expect, test, vi } from 'vite-plus/test'

import { NoContextException } from '../hooks/use-context-or-throw.ts'
import { AuthStateProvider } from './auth-state-provider.tsx'
import type { AuthStateStore } from './auth-state-store.ts'
import { type AuthState, Unauthed } from './auth-state.ts'
import { useAuthStateSetter } from './use-auth-state-setter.ts'

/**
 * Build a minimal in-memory {@link AuthStateStore} backed by a
 * `SubscriptionRef`. Generic to react-kitchen-sink — no slice-specific
 * factory (those live in app-side packages) is pulled in.
 */
const makeFakeStore = (): AuthStateStore => {
  const ref = Effect.runSync(SubscriptionRef.make<AuthState>(Unauthed()))
  return {
    subscribable: ref,
    setAuthState: (signal) => {
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

describe('useAuthStateSetter', () => {
  test("returns the store's setAuthState when wrapped in <AuthStateProvider>", () => {
    const store = makeFakeStore()
    const { result } = renderHook(useAuthStateSetter, {
      wrapper: ({ children }: { readonly children: ReactNode }): JSX.Element => (
        <AuthStateProvider store={store}>{children}</AuthStateProvider>
      ),
    })
    expect(result.current).toBe(store.setAuthState)
  })

  test('throws when rendered without <AuthStateProvider>', () => {
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(useAuthStateSetter)).toThrow(NoContextException)
    } finally {
      restore()
    }
  })
})
