import { QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { Effect, Layer } from 'effect'
import type { JSX } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import type { RouterContext } from '../router-context.ts'
import { Route as AuthRoute } from '../routes/_auth.tsx'
import { Route as FhirHomeRoute } from '../routes/fhir-home.tsx'
import { Route as SettingsRoute } from '../routes/settings.tsx'
import { plainSmartRouteOptions, wildflowerRouteOptions } from './auth-gated-route-options.ts'
import { ServerKind } from './server-kind.ts'

/**
 * Pins the server-kind half of the auth gate: past `awaitAuthReady`, a route
 * for the other kind of server redirects to that kind's Home before its loader
 * runs. The tree is a real `Router` with the real options spread into stub
 * routes at the paths `homeTabFor` names, plus a Wildflower-only `/collector`
 * whose loader is a spy — the stand-in for `_auth`'s Wildflower-only
 * prefetches.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PLAIN_SMART_SERVER = ServerKind.PlainSmart({
  fhirBaseUrl: 'https://launcher.smarthealthit.org/v/r4/fhir',
  patient: undefined,
})

const renderGatedAt = (
  initialPath: string,
  serverKind: ServerKind
): {
  readonly awaitAuthReady: ReturnType<typeof vi.fn<(returnTo?: string) => Promise<void>>>
  readonly collectorLoader: ReturnType<typeof vi.fn<() => void>>
} => {
  const awaitAuthReady = vi.fn((_returnTo?: string) => Promise.resolve())
  const collectorLoader = vi.fn(() => {})
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: () => <Outlet />,
  })
  const page = (text: string) => (): JSX.Element => <div>{text}</div>
  const collectorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/collector',
    ...wildflowerRouteOptions,
    loader: collectorLoader,
    component: page('collector page'),
  })
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/home',
    ...wildflowerRouteOptions,
    component: page('wildflower home'),
  })
  const fhirHomeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/fhir-home',
    ...plainSmartRouteOptions,
    component: page('plain smart home'),
  })
  const context: RouterContext = {
    queryClient: new QueryClient(),
    runAuthed: () => Promise.reject(new Error('runAuthed not used')),
    runtimeLayer: Layer.die('runtimeLayer not used'),
    awaitAuthReady,
    transport: Promise.resolve({
      sendMessage: () => Effect.void,
      coordinator: { register: () => Effect.void, unregister: () => Effect.void },
    }),
    entry: 'main-web',
    externalLinkRoot: () => 'https://example.test',
    serverKind,
  }
  const router = createRouter({
    routeTree: rootRoute.addChildren([collectorRoute, homeRoute, fhirHomeRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    context,
  })
  render(<RouterProvider router={router} />)
  return { awaitAuthReady, collectorLoader }
}

describe('wildflowerRouteOptions', () => {
  test('lets a Wildflower server’s session through to the route and its loader', async () => {
    // Act
    const { collectorLoader } = renderGatedAt('/collector', ServerKind.Wildflower())

    // Assert
    await screen.findByText('collector page')
    expect(collectorLoader).toHaveBeenCalled()
  })

  test('sends a plain SMART server’s session to its Home without running the loader', async () => {
    // Act
    const { awaitAuthReady, collectorLoader } = renderGatedAt('/collector', PLAIN_SMART_SERVER)

    // Assert — the auth gate still ran first, on the address asked for.
    await screen.findByText('plain smart home')
    expect(screen.queryByText('collector page')).toBeNull()
    expect(collectorLoader).not.toHaveBeenCalled()
    expect(awaitAuthReady).toHaveBeenCalledWith('/collector')
  })
})

describe('plainSmartRouteOptions', () => {
  test('lets a plain SMART server’s session through to its Home', async () => {
    // Act
    renderGatedAt('/fhir-home', PLAIN_SMART_SERVER)

    // Assert
    await screen.findByText('plain smart home')
  })

  test('sends a Wildflower server’s session to the Wildflower Home', async () => {
    // Act
    renderGatedAt('/fhir-home', ServerKind.Wildflower())

    // Assert
    await screen.findByText('wildflower home')
    expect(screen.queryByText('plain smart home')).toBeNull()
  })
})

describe('route wiring', () => {
  test('gates `_auth` and `/settings` as Wildflower-only, and `/fhir-home` as plain SMART only', () => {
    // Assert — the real routes spread the options this file exercises above.
    expect(AuthRoute.options.beforeLoad).toBe(wildflowerRouteOptions.beforeLoad)
    expect(SettingsRoute.options.beforeLoad).toBe(wildflowerRouteOptions.beforeLoad)
    expect(FhirHomeRoute.options.beforeLoad).toBe(plainSmartRouteOptions.beforeLoad)
  })
})
