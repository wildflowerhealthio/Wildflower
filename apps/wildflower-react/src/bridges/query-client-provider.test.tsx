import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute } from '@tanstack/react-router'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { Effect, Layer, SubscriptionRef } from 'effect'
import type { JSX, ReactNode } from 'react'
import { type AuthSignal, Unauthed } from 'react-kitchen-sink'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

/**
 * Pins that `renderApp` provides ONE shared in-memory `QueryClient` to
 * the whole tree — no persister.
 */

const { capturedQueryClients, LeafQueryClient } = vi.hoisted(() => {
  const captured: QueryClient[] = []
  const Leaf = (): JSX.Element => {
    captured.push(useQueryClient())
    return <div data-testid="leaf">leaf</div>
  }
  return { capturedQueryClients: captured, LeafQueryClient: Leaf }
})

const { Passthrough } = vi.hoisted(() => ({
  Passthrough: ({ children }: { readonly children?: ReactNode }): JSX.Element => <>{children}</>,
}))

// The gatekeeper-react surface this test pokes is just the
// `GatekeeperRouterContext.sliceRuntimeLayer` (consumed by
// `router-context.ts`'s layer composition). The `AuthTokenStore` the
// test renders with is constructed inline in the test body below.
// `ActiveDeviceUserCodeProvider` is mocked as a passthrough so the
// modal-host wrapping in `renderApp` doesn't blow up the tree, and
// `makeActiveDeviceUserCodeStore` returns a no-op store —
// `DeviceConsentModalHost` is stubbed to nothing for the same reason.
vi.mock('gatekeeper-react', () => ({
  GatekeeperRouterContext: { sliceRuntimeLayer: Layer.empty },
  ActiveDeviceUserCodeProvider: Passthrough,
  makeActiveDeviceUserCodeStore: () => ({
    subscribable: {
      get: Effect.succeed(null),
      changes: { pipe: () => ({}) },
    },
    setActiveUserCode: () => {},
  }),
  DeviceConsentModalHost: (): null => null,
}))
vi.mock('react-kitchen-sink', () => ({
  AuthTokenProvider: Passthrough,
  // The test seeds the store with `Unauthed()`; the mock only needs a value the
  // `SubscriptionRef` can hold (nothing asserts on it).
  Unauthed: () => ({ _tag: 'Unauthed' }),
  // Mirror the real `cn` helper so the ErrorBoundary in `renderApp`'s
  // tree (`react-tundraish` reads `cn` via this re-export) doesn't
  // crash if the rendered subtree throws. Same identity-on-truthy
  // shape as the production export.
  cn: (
    ...args: ReadonlyArray<string | undefined | null | false | Record<string, boolean>>
  ): string => args.filter((a): a is string => typeof a === 'string').join(' '),
  // Hook the prior subagent's test refactor relies on. Mock as a
  // synchronous passthrough so the consumer subtree sees the resolved
  // value immediately without scheduling.
  usePromiseOrDefault: <T,>(_promise: Promise<T>, fallback: T): T => fallback,
}))
vi.mock('collector-react', () => ({
  CollectorRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
// fhir-r4-react migrated off its client provider; the app composes its
// `sliceRuntimeLayer` (see `router-context.ts`), so mock that shape.
vi.mock('fhir-r4-react', () => ({
  FhirR4ResourcesRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
vi.mock('apps-react', () => ({
  AppsRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
// Prefetch is gated off; these stubs just satisfy the imports.
vi.mock('tunnel-react', () => ({
  tunnelStateQueryOptions: () => ({ queryKey: ['tunnel', 'state'], queryFn: () => null }),
  TunnelRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
vi.mock('./collector-sender-forwarder.tsx', () => ({
  CollectorSenderForwarder: Passthrough,
}))
vi.mock('telemetry-web', () => ({
  ErrorBoundary: ({ children }: { readonly children?: ReactNode }): JSX.Element => <>{children}</>,
  Sentry: { captureException: () => {} },
  webTelemetryLayerFromEnv: () => Layer.empty,
}))
// Bare `HttpClient` so the authed runtime constructs offline.
vi.mock('telemetry-react', () => ({
  webHttpClientLayer: Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
    )
  ),
}))
// Minimal route tree; leaf records the `QueryClient` it sees.
vi.mock('../routeTree.gen.ts', () => {
  const rootRoute = createRootRoute({ component: RootShell })
  const leaf = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: LeafQueryClient,
  })
  return { routeTree: rootRoute.addChildren([leaf]) }
})

import { RootShell } from '../session/root-shell.tsx'

describe('in-memory QueryClientProvider', () => {
  beforeEach(() => {
    capturedQueryClients.length = 0
    const container = document.createElement('div')
    container.id = 'root'
    document.body.appendChild(container)
  })

  afterEach(() => {
    cleanup()
    document.getElementById('root')?.remove()
    vi.restoreAllMocks()
  })

  test('provides a single shared QueryClient to the whole tree', async () => {
    const { renderApp } = await import('../app-root.tsx')

    const { stubTransport } = await import('./transport-context.ts')
    // Minimal in-memory `AuthTokenStore` — this test only pins the
    // `QueryClient` sharing contract, not anything about the bearer.
    // Construction matches `makeEmbeddedAuthTokenStore`'s shape: a
    // `SubscriptionRef<string | null>` starting at `null` plus a
    // synchronous setter that writes through it.
    const tokenRef = Effect.runSync(SubscriptionRef.make<AuthSignal>(Unauthed()))
    const tokenStore = {
      subscribable: tokenRef,
      setSignal: (s: AuthSignal): void => Effect.runSync(SubscriptionRef.set(tokenRef, s)),
    }
    await act(async () => {
      renderApp({
        history: createMemoryHistory({ initialEntries: ['/'] }),
        entry: 'main-web',
        tokenStore,
        awaitAuthReady: () => () => Promise.resolve(),
        makeTransport: () => Promise.resolve(stubTransport),
        platformSettingsItems: [],
        makeOnUnauthorized: () => () => undefined,
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('leaf')).toBeDefined()
    })

    // StrictMode may double-invoke; every capture must be the same instance.
    expect(capturedQueryClients.length).toBeGreaterThan(0)
    const first = capturedQueryClients[0]
    expect(first).toBeInstanceOf(QueryClient)
    for (const client of capturedQueryClients) {
      expect(client).toBe(first)
    }
  })
})
