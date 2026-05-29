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
import { type JSX, useSyncExternalStore } from 'react'
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

type AnyRouter = ReturnType<typeof createRouter>

/**
 * Builds a router whose root component re-reads the sender from an
 * external store on every render. Tests can swap the active sender via
 * the returned `setSender` and trigger a re-render — the router (and
 * therefore the navigation history) is preserved across the swap, which
 * lets us assert that a new sender *reference* alone does not cause the
 * bridge to refire.
 */
const buildRouterWithSwappableSender = (
  initialSender: RouteChangeSender,
  initialEntry: string
): {
  readonly router: AnyRouter
  readonly setSender: (next: RouteChangeSender) => void
} => {
  let current: RouteChangeSender = initialSender
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const getSnapshot = (): RouteChangeSender => current
  const setSender = (next: RouteChangeSender): void => {
    current = next
    for (const listener of listeners) listener()
  }

  const RootComponent = (): JSX.Element => {
    const sender = useSyncExternalStore(subscribe, getSnapshot)
    return <NavigationBridgeHandler sender={sender} />
  }

  const rootRoute = createRootRoute({ component: RootComponent })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/', component: blankComponent }),
    createRoute({ getParentRoute: () => rootRoute, path: '/start', component: blankComponent }),
    createRoute({ getParentRoute: () => rootRoute, path: '/next', component: blankComponent }),
    createRoute({ getParentRoute: () => rootRoute, path: '/foo', component: blankComponent }),
  ])
  const router: AnyRouter = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  return { router, setSender }
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

    // Pin the call count: one fire on initial mount + one per navigation.
    // Anything that bumps this past 2 (e.g. an extra `useEffect` trigger
    // from `location.state` identity churn) is a real regression.
    expect(calls).toHaveLength(2)
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

    // Pin the call count: initial mount + 4 successful navigations.
    // The extra clamped back is a no-op in TanStack memory history (it
    // emits no `location` change), so no 6th fire is expected. If this
    // assertion starts failing high, identity churn on `location.state`
    // is leaking through the dep array.
    expect(calls).toHaveLength(5)
  })

  test('re-rendering with a new sender reference does not retrigger the bridge', async () => {
    const { calls: callsA, send: senderA } = setupCalls()
    const { calls: callsB, send: senderB } = setupCalls()
    const { router, setSender } = buildRouterWithSwappableSender(senderA, '/start')

    render(<RouterProvider router={router} />)

    // Let the initial fire settle on senderA.
    await waitFor(() => {
      expect(callsA[0]).toEqual({ _tag: 'RouteChanged', pathname: '/start', canGoBack: false })
    })
    const initialACount = callsA.length

    // Swap to a brand-new sender reference. No router navigation occurs —
    // only the `sender` prop identity changes. If `send` in the
    // `useEffect` dep array is itself a fire-trigger, callsB will grow.
    await act(async () => {
      setSender(senderB)
    })

    // Give any spurious effect a chance to run before asserting.
    await act(async () => {
      await Promise.resolve()
    })

    expect(callsA).toHaveLength(initialACount)
    expect(callsB).toHaveLength(0)

    // Sanity: a real navigation under senderB still fires (i.e. the swap
    // didn't sever the subscription).
    await act(async () => {
      await router.navigate({ to: '/next' })
    })
    await waitFor(() => {
      expect(callsB.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/next', canGoBack: true })
    })
    expect(callsB).toHaveLength(1)
    expect(callsA).toHaveLength(initialACount)
  })
})
