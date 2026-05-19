import { cleanup, render, renderHook } from '@testing-library/react'
import { Effect, Layer, SubscriptionRef } from 'effect'
import { type JSX, type ReactNode } from 'react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { TunnelClientProvider } from '../src/tunnel-client-provider.tsx'
import { useTunnelAdminClientLayer } from '../src/use-tunnel-admin-client-layer.ts'

const makeTokenRef = (initial: string | null): SubscriptionRef.SubscriptionRef<string | null> =>
  Effect.runSync(SubscriptionRef.make(initial))

describe('useTunnelAdminClientLayer', () => {
  // `render()` / `renderHook()` mount to the shared jsdom `body`;
  // without cleanup the previous test's tree lingers and provider
  // contexts can leak between assertions.
  afterEach(() => {
    cleanup()
  })

  test('throws when used outside <TunnelClientProvider>', () => {
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <AuthTokenProvider subscribable={makeTokenRef(null)}>{children}</AuthTokenProvider>
    )
    expect(() => renderHook(() => useTunnelAdminClientLayer(), { wrapper })).toThrow(
      /<TunnelClientProvider>/
    )
  })

  test('returns a fully provided Layer when wrapped with both providers', () => {
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <AuthTokenProvider subscribable={makeTokenRef('test-token')}>
        <TunnelClientProvider>{children}</TunnelClientProvider>
      </AuthTokenProvider>
    )
    const { result } = renderHook(() => useTunnelAdminClientLayer(), { wrapper })
    expect(Layer.isLayer(result.current)).toBe(true)
  })

  test('layer reference is stable across renders given a stable token Subscribable', () => {
    const tokenRef = makeTokenRef('test-token')
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <AuthTokenProvider subscribable={tokenRef}>
        <TunnelClientProvider>{children}</TunnelClientProvider>
      </AuthTokenProvider>
    )
    const { result, rerender } = renderHook(() => useTunnelAdminClientLayer(), { wrapper })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  test('<TunnelClientProvider> renders children unchanged', () => {
    const { container } = render(
      <AuthTokenProvider subscribable={makeTokenRef(null)}>
        <TunnelClientProvider>
          <span data-testid="child">ok</span>
        </TunnelClientProvider>
      </AuthTokenProvider>
    )
    expect(container.querySelector('[data-testid="child"]')?.textContent).toBe('ok')
  })
})
