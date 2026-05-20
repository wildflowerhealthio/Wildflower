import { HttpApi, HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { cleanup, render, renderHook } from '@testing-library/react'
import { Effect, Layer, Schema, SubscriptionRef } from 'effect'
import { type JSX, type ReactNode } from 'react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { defineSliceReact } from '../src/define-slice-react.tsx'

// ---------------------------------------------------------------------------
// Fixture: build a complete slice (`ClientTag` + layer) via the core helper,
// then plug it into `defineSliceReact`. Two fixtures — one bearer, one
// public — exercise both auth modes.
// ---------------------------------------------------------------------------

const FixtureBody = Schema.Struct({ ok: Schema.Boolean })
const fixtureGroup = HttpApiGroup.make('fixture', { topLevel: false }).add(
  HttpApiEndpoint.get('GetFixture', '/fixture').addSuccess(FixtureBody)
)
const FixtureApi = HttpApi.make('FixtureApi').add(fixtureGroup)

const bearerHc = defineSliceHttpClient({
  name: 'TestBearerClient',
  api: FixtureApi,
  authType: 'bearer',
})
class TestBearerClient extends bearerHc.ClientTag<TestBearerClient>() {
  static readonly layer = bearerHc.makeLayerFactory(TestBearerClient)()
  static readonly authType = bearerHc.authType
}

const publicHc = defineSliceHttpClient({
  name: 'TestPublicClient',
  api: FixtureApi,
  authType: 'none',
})
class TestPublicClient extends publicHc.ClientTag<TestPublicClient>() {
  static readonly layer = publicHc.makeLayerFactory(TestPublicClient)()
  static readonly authType = publicHc.authType
}

const makeTokenRef = (initial: string | null): SubscriptionRef.SubscriptionRef<string | null> =>
  Effect.runSync(SubscriptionRef.make(initial))

describe('defineSliceReact (authType: bearer)', () => {
  afterEach(() => {
    cleanup()
  })

  test('useClientLayer throws when used outside ClientProvider', () => {
    const { useClientLayer } = defineSliceReact({
      ClientTag: TestBearerClient,
      layer: TestBearerClient.layer,
      authType: TestBearerClient.authType,
      contextName: 'TestBearer',
    })
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <AuthTokenProvider subscribable={makeTokenRef(null)}>{children}</AuthTokenProvider>
    )
    expect(() => renderHook(() => useClientLayer(), { wrapper })).toThrow(
      /<TestBearerClientProvider>/
    )
  })

  test('useClientLayer returns a fully-provided Layer when wrapped', () => {
    const { ClientProvider, useClientLayer } = defineSliceReact({
      ClientTag: TestBearerClient,
      layer: TestBearerClient.layer,
      authType: TestBearerClient.authType,
      contextName: 'TestBearer',
    })
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <AuthTokenProvider subscribable={makeTokenRef('test-token')}>
        <ClientProvider>{children}</ClientProvider>
      </AuthTokenProvider>
    )
    const { result } = renderHook(() => useClientLayer(), { wrapper })
    expect(Layer.isLayer(result.current)).toBe(true)
  })

  test('useClientLayer reference is stable across renders given a stable Subscribable', () => {
    const tokenRef = makeTokenRef('test-token')
    const { ClientProvider, useClientLayer } = defineSliceReact({
      ClientTag: TestBearerClient,
      layer: TestBearerClient.layer,
      authType: TestBearerClient.authType,
      contextName: 'TestBearer',
    })
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <AuthTokenProvider subscribable={tokenRef}>
        <ClientProvider>{children}</ClientProvider>
      </AuthTokenProvider>
    )
    const { result, rerender } = renderHook(() => useClientLayer(), { wrapper })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  test('ClientProvider renders children unchanged', () => {
    const { ClientProvider } = defineSliceReact({
      ClientTag: TestBearerClient,
      layer: TestBearerClient.layer,
      authType: TestBearerClient.authType,
      contextName: 'TestBearer',
    })
    const { container } = render(
      <AuthTokenProvider subscribable={makeTokenRef(null)}>
        <ClientProvider>
          <span data-testid="child">ok</span>
        </ClientProvider>
      </AuthTokenProvider>
    )
    expect(container.querySelector('[data-testid="child"]')?.textContent).toBe('ok')
  })

  test('ClientLayerContext gets a descriptive displayName for React DevTools', () => {
    const { ClientLayerContext } = defineSliceReact({
      ClientTag: TestBearerClient,
      layer: TestBearerClient.layer,
      authType: TestBearerClient.authType,
      contextName: 'TestBearer',
    })
    expect(ClientLayerContext.displayName).toBe('TestBearerClientLayerContext')
  })
})

describe('defineSliceReact (authType: none)', () => {
  afterEach(() => {
    cleanup()
  })

  test('useClientLayer throws when used outside ClientProvider', () => {
    const { useClientLayer } = defineSliceReact({
      ClientTag: TestPublicClient,
      layer: TestPublicClient.layer,
      authType: TestPublicClient.authType,
      contextName: 'TestPublic',
    })
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <AuthTokenProvider subscribable={makeTokenRef(null)}>{children}</AuthTokenProvider>
    )
    expect(() => renderHook(() => useClientLayer(), { wrapper })).toThrow(
      /<TestPublicClientProvider>/
    )
  })

  test('useClientLayer returns a Layer for the public client', () => {
    const { ClientProvider, useClientLayer } = defineSliceReact({
      ClientTag: TestPublicClient,
      layer: TestPublicClient.layer,
      authType: TestPublicClient.authType,
      contextName: 'TestPublic',
    })
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <AuthTokenProvider subscribable={makeTokenRef(null)}>
        <ClientProvider>{children}</ClientProvider>
      </AuthTokenProvider>
    )
    const { result } = renderHook(() => useClientLayer(), { wrapper })
    expect(Layer.isLayer(result.current)).toBe(true)
  })
})
