import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute } from '@tanstack/react-router'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import type * as AuthorizationReact from '@wildflowerhealthio/authorization-react'
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

// The authorization-react surface this test pokes is the
// `AuthorizationRouterContext.sliceRuntimeLayer` (consumed by
// `router-context.ts`'s layer composition) and the logout row
// `buildAppTree` builds. The bearer store the test renders with is
// constructed inline in the test body below.
vi.mock('@wildflowerhealthio/authorization-react', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthorizationReact>()
  return {
    AuthorizationRouterContext: { sliceRuntimeLayer: Layer.empty },
    authorizationLogoutSettingsItem: actual.authorizationLogoutSettingsItem,
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
}))
// fhir-r4-react migrated off its client provider; the app composes its
// `sliceRuntimeLayer` (see `router-context.ts`), so mock that shape.
vi.mock('@wildflowerhealthio/fhir-r4-react', () => ({
  FhirR4ResourcesRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
vi.mock('@wildflowerhealthio/apps-react', () => ({
  AppsRouterContext: { sliceRuntimeLayer: Layer.empty },
}))
vi.mock('@wildflowerhealthio/telemetry-web', () => ({
  ErrorBoundary: ({ children }: { readonly children?: ReactNode }): JSX.Element => <>{children}</>,
  Sentry: { captureException: () => {} },
}))
// Minimal route tree; leaf records the `QueryClient` it sees.
vi.mock('./routeTree.gen.ts', () => {
  const rootRoute = createRootRoute({ component: RootShell })
  const leaf = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: LeafQueryClient,
  })
  return { routeTree: rootRoute.addChildren([leaf]) }
})

import { RootShell } from './session/root-shell.tsx'
import { ServerKind } from './session/server-kind.ts'

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
    const { buildAppTree, mountAtRoot } = await import('./app-root.tsx')

    // Minimal in-memory bearer store — this test only pins the
    // `QueryClient` sharing contract, not anything about the session: a
    // `SubscriptionRef<AuthState>` starting `Unauthed` plus a synchronous
    // setter that writes through it, and no session.
    const tokenRef = Effect.runSync(SubscriptionRef.make<AuthState>(Unauthed()))
    const tokenStore = {
      subscribable: tokenRef,
      setAuthState: (s: AuthState): void => Effect.runSync(SubscriptionRef.set(tokenRef, s)),
      serverUrl: (): string | undefined => undefined,
      bearer: (): string | undefined => undefined,
      writeSession: (): void => {},
    }
    await act(async () => {
      mountAtRoot(
        buildAppTree({
          history: createMemoryHistory({ initialEntries: ['/'] }),
          tokenStore,
          awaitAuthReady: () => Promise.resolve(),
          effectTelemetryLayer: Layer.empty,
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
