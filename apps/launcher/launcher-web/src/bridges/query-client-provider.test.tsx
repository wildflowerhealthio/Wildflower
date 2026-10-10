import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute } from '@tanstack/react-router'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import type * as GatekeeperReact from '@wildflowerhealthio/gatekeeper-react'
import { type AuthState, Unauthed } from '@wildflowerhealthio/react-kitchen-sink'
import { Effect, Layer, SubscriptionRef } from 'effect'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

/**
 * Pins that `buildAppTree` provides ONE shared in-memory `QueryClient` to
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
// `router-context.ts`'s layer composition). The `AuthStateStore` the
// test renders with is constructed inline in the test body below.
// `ActivePendingConsentProvider` is mocked as a passthrough so the
// modal-host wrapping in `buildAppTree` doesn't blow up the tree, and
// `makeActivePendingConsentStore` returns a no-op store —
// `PendingConsentModalHost` is stubbed to nothing for the same reason.
vi.mock('@wildflowerhealthio/gatekeeper-react', async (importOriginal) => {
  const actual = await importOriginal<typeof GatekeeperReact>()
  return {
    GatekeeperRouterContext: { sliceRuntimeLayer: Layer.empty },
    ActivePendingConsentProvider: Passthrough,
    makeActivePendingConsentStore: () => ({
      subscribable: {
        get: Effect.succeed(null),
        changes: { pipe: () => ({}) },
      },
      setActiveHead: () => {},
    }),
    PendingConsentModalHost: (): null => null,
    TokenResponseHandlerContext: actual.TokenResponseHandlerContext,
  }
})
vi.mock('@wildflowerhealthio/react-kitchen-sink', () => ({
  AuthStateProvider: Passthrough,
  // The test seeds the store with `Unauthed()`; the mock only needs a value the
  // `SubscriptionRef` can hold (nothing asserts on it).
  Unauthed: () => ({ _tag: 'Unauthed' }),
  // Mirror the real `cn` helper so the ErrorBoundary in `buildAppTree`'s
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
vi.mock('@wildflowerhealthio/collector-react', () => ({
  CollectorRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
// fhir-r4-react migrated off its client provider; the app composes its
// `sliceRuntimeLayer` (see `router-context.ts`), so mock that shape.
vi.mock('@wildflowerhealthio/fhir-r4-react', () => ({
  FhirR4ResourcesRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
vi.mock('@wildflowerhealthio/apps-react', () => ({
  AppsRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
vi.mock('./collector-sender-forwarder.tsx', () => ({
  CollectorSenderForwarder: Passthrough,
}))
vi.mock('./har-recorder-sender-forwarder.tsx', () => ({
  HarRecorderSenderForwarder: Passthrough,
}))
vi.mock('./background-server-service-sender-forwarder.tsx', () => ({
  BackgroundServerServiceSenderForwarder: Passthrough,
}))
// `buildAppTree` builds the server status store through the real
// `react-kitchen-sink` store plumbing, which this harness mocks away; the
// provider is a passthrough and the store a no-op, as for the pending-consent
// store above.
vi.mock('@wildflowerhealthio/wildflower-server-react', () => ({
  ServerServiceStatusProvider: Passthrough,
  makeServerServiceStatusStore: () => ({
    subscribable: {
      get: Effect.succeed(null),
      changes: { pipe: () => ({}) },
    },
    setStatus: () => {},
  }),
}))
vi.mock('@wildflowerhealthio/telemetry-web', () => ({
  ErrorBoundary: ({ children }: { readonly children?: ReactNode }): JSX.Element => <>{children}</>,
  Sentry: { captureException: () => {} },
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
import { ServerKind } from '../session/server-kind.ts'

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
    const { buildAppTree, mountAtRoot } = await import('../app-root.tsx')

    const { stubTransport } = await import('./transport-context.ts')
    // Minimal in-memory `AuthStateStore` — this test only pins the
    // `QueryClient` sharing contract, not anything about the bearer.
    // Construction matches `makeEmbeddedAuthStateStore`'s shape: a
    // `SubscriptionRef<string | null>` starting at `null` plus a
    // synchronous setter that writes through it.
    const tokenRef = Effect.runSync(SubscriptionRef.make<AuthState>(Unauthed()))
    const tokenStore = {
      subscribable: tokenRef,
      setAuthState: (s: AuthState): void => Effect.runSync(SubscriptionRef.set(tokenRef, s)),
    }
    await act(async () => {
      mountAtRoot(
        buildAppTree({
          history: createMemoryHistory({ initialEntries: ['/'] }),
          entry: 'main-web',
          tokenStore,
          awaitAuthReady: () => () => Promise.resolve(),
          makeTransport: () => Promise.resolve(stubTransport),
          effectTelemetryLayer: Layer.empty,
          externalLinkRoot: () => 'https://example.test',
          platformSettingsItems: [],
          platformTabs: [],
          platformBanner: null,
          redirectToDeviceLoginOnUnauthorized: false,
          serverKind: ServerKind.Wildflower(),
        })
      )
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
