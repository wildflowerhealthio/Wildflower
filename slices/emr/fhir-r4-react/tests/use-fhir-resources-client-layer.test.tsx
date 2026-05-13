import { render, renderHook } from '@testing-library/react'
import { Effect, Layer, SubscriptionRef } from 'effect'
import { type JSX, type ReactNode } from 'react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { describe, expect, test } from 'vite-plus/test'

import { FhirResourcesClientProvider } from '../src/fhir-resources-client-provider.tsx'
import { useFhirResourcesClientLayer } from '../src/use-fhir-resources-client-layer.ts'

const makeTokenRef = (initial: string | null): SubscriptionRef.SubscriptionRef<string | null> =>
  Effect.runSync(SubscriptionRef.make(initial))

describe('useFhirResourcesClientLayer', () => {
  test('throws when used outside <FhirResourcesClientProvider>', () => {
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <AuthTokenProvider subscribable={makeTokenRef(null)}>{children}</AuthTokenProvider>
    )
    expect(() => renderHook(() => useFhirResourcesClientLayer(), { wrapper })).toThrow(
      /<FhirResourcesClientProvider>/
    )
  })

  test('returns a fully provided Layer when wrapped with both providers', () => {
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <AuthTokenProvider subscribable={makeTokenRef('test-token')}>
        <FhirResourcesClientProvider>{children}</FhirResourcesClientProvider>
      </AuthTokenProvider>
    )
    const { result } = renderHook(() => useFhirResourcesClientLayer(), { wrapper })
    expect(Layer.isLayer(result.current)).toBe(true)
  })

  test('<FhirResourcesClientProvider> renders children unchanged', () => {
    const { container } = render(
      <AuthTokenProvider subscribable={makeTokenRef(null)}>
        <FhirResourcesClientProvider>
          <span data-testid="child">ok</span>
        </FhirResourcesClientProvider>
      </AuthTokenProvider>
    )
    expect(container.querySelector('[data-testid="child"]')?.textContent).toBe('ok')
  })
})
