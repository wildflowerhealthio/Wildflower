import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, render, waitFor } from '@testing-library/react'
import { Effect } from 'effect'
import type { NavigationBridge } from 'navigation-core'
import { type JSX } from 'react'
import { describe, expect, test } from 'vite-plus/test'

import { NavigationBridgeHandler, type RouteChangeSender } from './navigation-bridge-handler'

type RouteChanged = NavigationBridge['MessageSchemas']['RouteChanged']['Type']

const setupCalls = (): {
  readonly calls: RouteChanged[]
  readonly send: RouteChangeSender
} => {
  const calls: RouteChanged[] = []
  // Record on Effect *run*, not on construction. A push-on-call mock
  // would pass even when production code discards the returned Effect —
  // exactly the regression `NavigationBridgeHandler` had until Fix C.
  const send: RouteChangeSender = (message) =>
    Effect.sync(() => {
      calls.push(message)
    })
  return { calls, send }
}

const blankComponent = (): JSX.Element | null => null

const buildRouter = (
  send: RouteChangeSender,
  initialEntry: string
): ReturnType<typeof createRouter> => {
  const rootRoute = createRootRoute({
    component: () => <NavigationBridgeHandler sender={send} />,
  })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/', component: blankComponent }),
    createRoute({ getParentRoute: () => rootRoute, path: '/start', component: blankComponent }),
    createRoute({ getParentRoute: () => rootRoute, path: '/next', component: blankComponent }),
    createRoute({ getParentRoute: () => rootRoute, path: '/foo', component: blankComponent }),
  ])
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
}

describe('NavigationBridgeHandler', () => {
  test('fires the callback once per navigation, with canGoBack tracking history depth', async () => {
    const { calls, send } = setupCalls()
    const router = buildRouter(send, '/start')

    render(<RouterProvider router={router} />)

    // TanStack `<RouterProvider>` resolves its first match asynchronously
    // (loaders + state-store hydration), so `NavigationBridgeHandler`'s
    // `useEffect` only fires once the location subscription is wired up.
    // `waitFor` collapses the timing windows into a single, deterministic
    // assertion.
    await waitFor(() => {
      // Initial POP-equivalent (router boot at index 0) → canGoBack false.
      expect(calls[0]).toEqual({ _tag: 'RouteChanged', pathname: '/start', canGoBack: false })
    })

    // Push → canGoBack true (history index advances to 1).
    await act(async () => {
      await router.navigate({ to: '/next' })
    })
    await waitFor(() => {
      expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/next', canGoBack: true })
    })
  })

  // Push/Pop sequences should land canGoBack at false on the initial route and
  // never permit a negative depth — TanStack's `useCanGoBack` reads
  // `history.index > 0`, which clamps naturally at the initial entry.
  test('repeated push-then-pop cycles return to canGoBack=false without going negative', async () => {
    const { calls, send } = setupCalls()
    const router = buildRouter(send, '/')

    render(<RouterProvider router={router} />)

    // Initial mount: at index 0 on '/'.
    await waitFor(() => {
      expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/', canGoBack: false })
    })

    await act(async () => {
      await router.navigate({ to: '/foo' })
    })
    await waitFor(() => {
      expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/foo', canGoBack: true })
    })

    await act(async () => {
      router.history.back()
    })
    await waitFor(() => {
      expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/', canGoBack: false })
    })

    await act(async () => {
      await router.navigate({ to: '/foo' })
    })
    await waitFor(() => {
      expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/foo', canGoBack: true })
    })

    await act(async () => {
      router.history.back()
    })
    await waitFor(() => {
      expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/', canGoBack: false })
    })

    // Extra Pop past the initial entry: history clamps at index 0, so the
    // bridge keeps `canGoBack=false`.
    await act(async () => {
      router.history.back()
    })
    await waitFor(() => {
      expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/', canGoBack: false })
    })
  })
})
