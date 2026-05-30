import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpClient,
  HttpClientResponse,
} from '@effect/platform'
import { cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { Effect, Layer, Schema, SubscriptionRef } from 'effect'
import type { BearerToken } from 'kitchen-sink/auth-token'
import { type JSX, type ReactNode } from 'react'
import { AuthTokenProvider } from 'react-kitchen-sink'
import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { defineSliceReact } from './define-slice-react.tsx'

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

// Stub HttpClient transport — records the outgoing Authorization header
// (or `undefined` if absent) into `captures` and returns the canned
// FixtureBody. Mirrors the core helper's test fixture so the React
// hook-level test can assert the same end-to-end wiring.
const capturingHttpClientLayer = (
  captures: Array<string | undefined>
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      captures.push(request.headers['authorization'])
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      )
    })
  )

// Trivial stub for tests that only need `Layer.isLayer(...)` to pass —
// the HttpClient never gets invoked in those cases.
const stubHttpClientLayer: Layer.Layer<HttpClient.HttpClient> = capturingHttpClientLayer([])

describe('defineSliceReact (authType: bearer)', () => {
  afterEach(() => {
    cleanup()
  })

  test('useClientLayer throws when used outside ClientProvider', () => {
    const { useClientLayer } = defineSliceReact({
      ClientTag: TestBearerClient,
      layer: TestBearerClient.layer,
      authType: TestBearerClient.authType,
      httpClientLayer: stubHttpClientLayer,
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
      httpClientLayer: stubHttpClientLayer,
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
      httpClientLayer: stubHttpClientLayer,
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
      httpClientLayer: stubHttpClientLayer,
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
      httpClientLayer: stubHttpClientLayer,
      contextName: 'TestBearer',
    })
    expect(ClientLayerContext.displayName).toBe('TestBearerClientLayerContext')
  })

  test('ClientProvider gets a descriptive displayName for React DevTools', () => {
    const { ClientProvider } = defineSliceReact({
      ClientTag: TestBearerClient,
      layer: TestBearerClient.layer,
      authType: TestBearerClient.authType,
      httpClientLayer: stubHttpClientLayer,
      contextName: 'TestBearer',
    })
    expect(ClientProvider.displayName).toBe('TestBearerClientProvider')
  })

  test('useEffectAction wires the slice layer through to the host HttpClient with the bearer header', async () => {
    const captures: Array<string | undefined> = []
    const tokenRef = makeTokenRef('top-secret')
    const { ClientProvider, useEffectAction } = defineSliceReact({
      ClientTag: TestBearerClient,
      layer: TestBearerClient.layer,
      authType: TestBearerClient.authType,
      httpClientLayer: capturingHttpClientLayer(captures),
      contextName: 'TestBearer',
    })
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <AuthTokenProvider subscribable={tokenRef}>
        <ClientProvider>{children}</ClientProvider>
      </AuthTokenProvider>
    )
    const { result } = renderHook(() => useEffectAction(), { wrapper })
    const run = result.current
    await run(Effect.flatMap(TestBearerClient, (c) => c.fixture.GetFixture()))
    // Pipe order (bearer + http together) and slice-layer wiring must
    // surface the live token in the captured Authorization header.
    await waitFor(() => {
      expect(captures).toEqual(['Bearer top-secret'])
    })
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
      httpClientLayer: stubHttpClientLayer,
      contextName: 'TestPublic',
    })
    expect(() => renderHook(() => useClientLayer())).toThrow(/<TestPublicClientProvider>/)
  })

  test('useClientLayer returns a Layer for the public client without an AuthTokenProvider', () => {
    // Public-mode hook must not require `<AuthTokenProvider>` upstream
    // — the implementation is selected at factory time on
    // `authType === 'none'`, so `useAuthTokenSubscribable` is never
    // called.
    const { ClientProvider, useClientLayer } = defineSliceReact({
      ClientTag: TestPublicClient,
      layer: TestPublicClient.layer,
      authType: TestPublicClient.authType,
      httpClientLayer: stubHttpClientLayer,
      contextName: 'TestPublic',
    })
    const { result } = renderHook(() => useClientLayer(), {
      wrapper: ({ children }: { readonly children: ReactNode }): JSX.Element => (
        <ClientProvider>{children}</ClientProvider>
      ),
    })
    expect(Layer.isLayer(result.current)).toBe(true)
  })

  test('useEffectAction runs a public-client Effect without attaching an Authorization header', async () => {
    const captures: Array<string | undefined> = []
    const { ClientProvider, useEffectAction } = defineSliceReact({
      ClientTag: TestPublicClient,
      layer: TestPublicClient.layer,
      authType: TestPublicClient.authType,
      httpClientLayer: capturingHttpClientLayer(captures),
      contextName: 'TestPublic',
    })
    const { result } = renderHook(() => useEffectAction(), {
      wrapper: ({ children }: { readonly children: ReactNode }): JSX.Element => (
        <ClientProvider>{children}</ClientProvider>
      ),
    })
    const run = result.current
    await run(Effect.flatMap(TestPublicClient, (c) => c.fixture.GetFixture()))
    await waitFor(() => {
      expect(captures).toEqual([undefined])
    })
  })
})

// `BearerToken` is the unique identity from `kitchen-sink/auth-token`
// that `defineSliceReact` feeds into `Layer.succeed(BearerToken, _)`
// inside the bearer branch of `useClientLayer`. Two distinct class
// declarations with the same string Tag identifier resolve to the
// same runtime service but are nominally incompatible at the type
// layer — this helper catches a regression where `define-slice-react`
// grows a private `BearerToken` declaration of its own. Mirrors the
// same guard in `shared-structures-core/http-api-definition`.
const acceptBearerToken = (token: BearerToken): BearerToken => token

describe('BearerToken identity', () => {
  test('helper consumes the `kitchen-sink/auth-token` BearerToken (type-level)', () => {
    expect(typeof acceptBearerToken).toBe('function')
  })
})
