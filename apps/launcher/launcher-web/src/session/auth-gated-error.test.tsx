import { QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Layer } from 'effect'
import type { JSX } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import type { RouterContext } from '../router-context.ts'
import { wildflowerRouteOptions } from './auth-gated-route-options.ts'
import { ServerKind } from './server-kind.ts'

/**
 * Pins the retry path: clicking the Retry button must re-fire the
 * route's `beforeLoad` (which calls `awaitAuthReady` again) — NOT just
 * clear the local error state. TanStack's `errorComponent.reset` only
 * clears the matched route's error and would loop straight back to the
 * same error, so the screen drives `router.invalidate()` instead.
 *
 * The test wires a real `Router` with the real `_auth.beforeLoad` and
 * an `awaitAuthReady` spy that rejects. After the gate's first call lands
 * the error component, the test clicks Retry and waits for a second call.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const renderGate = (
  awaitAuthReady: () => Promise<void>
): { findRetryButton: () => Promise<HTMLElement> } => {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    ...wildflowerRouteOptions,
    component: () => <Outlet />,
  })
  const leaf = rootRoute.addChildren([])
  const context: RouterContext = {
    queryClient: new QueryClient(),
    runAuthed: () => Promise.reject(new Error('runAuthed not used')),
    runtimeLayer: Layer.die('runtimeLayer not used'),
    awaitAuthReady,
    externalLinkRoot: () => 'https://example.test',
    serverKind: ServerKind.Wildflower(),
  }
  const router = createRouter({
    routeTree: leaf,
    history: createMemoryHistory({ initialEntries: ['/'] }),
    context,
  })

  const TestRoot = (): JSX.Element => <RouterProvider router={router} />

  render(<TestRoot />)
  return {
    findRetryButton: () => screen.findByRole('button', { name: /retry/i }),
  }
}

describe('AuthGatedErrorComponent', () => {
  test('shows the failure, and Retry re-fires the auth gate (router.invalidate path)', async () => {
    // Arrange
    const awaitAuthReady = vi.fn(() => Promise.reject(new Error('database is down')))
    const { findRetryButton } = renderGate(awaitAuthReady)
    await waitFor(() => {
      expect(awaitAuthReady).toHaveBeenCalledTimes(1)
    })
    expect(await screen.findByText('Something went wrong')).toBeDefined()
    expect(await screen.findByText('database is down')).toBeDefined()

    // Act
    const button = await findRetryButton()
    await act(async () => {
      button.click()
    })

    // Assert — the second call is what pins the difference between `reset`
    // (which wouldn't re-run `beforeLoad`) and `router.invalidate()` (which
    // does). Without the switch, this would stay at 1 forever.
    await waitFor(() => {
      expect(awaitAuthReady).toHaveBeenCalledTimes(2)
    })
  })
})
