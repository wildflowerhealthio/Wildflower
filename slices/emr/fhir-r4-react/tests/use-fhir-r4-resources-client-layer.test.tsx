import { render, renderHook } from '@testing-library/react'
import { Effect, Layer, SubscriptionRef } from 'effect'
import { type JSX, type ReactNode } from 'react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { describe, expect, test } from 'vite-plus/test'

import { FhirR4ResourcesClientProvider } from '../src/fhir-r4-resources-client-provider.tsx'
import { useFhirR4ResourcesClientLayer } from '../src/use-fhir-r4-resources-client-layer.ts'

const makeTokenRef = (initial: string | null): SubscriptionRef.SubscriptionRef<string | null> =>
  Effect.runSync(SubscriptionRef.make(initial))

describe('useFhirR4ResourcesClientLayer', () => {
  test('throws when used outside <FhirR4ResourcesClientProvider>', () => {
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <AuthTokenProvider subscribable={makeTokenRef(null)}>{children}</AuthTokenProvider>
    )
    expect(() => renderHook(() => useFhirR4ResourcesClientLayer(), { wrapper })).toThrow(
      /<FhirR4ResourcesClientProvider>/
    )
  })

  test('returns a fully provided Layer when wrapped with both providers', () => {
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <AuthTokenProvider subscribable={makeTokenRef('test-token')}>
        <FhirR4ResourcesClientProvider>{children}</FhirR4ResourcesClientProvider>
      </AuthTokenProvider>
    )
    const { result } = renderHook(() => useFhirR4ResourcesClientLayer(), { wrapper })
    expect(Layer.isLayer(result.current)).toBe(true)
  })

  test('<FhirR4ResourcesClientProvider> renders children unchanged', () => {
    const { container } = render(
      <AuthTokenProvider subscribable={makeTokenRef(null)}>
        <FhirR4ResourcesClientProvider>
          <span data-testid="child">ok</span>
        </FhirR4ResourcesClientProvider>
      </AuthTokenProvider>
    )
    expect(container.querySelector('[data-testid="child"]')?.textContent).toBe('ok')
  })
})
