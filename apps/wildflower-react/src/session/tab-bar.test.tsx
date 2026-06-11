import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { JSX, ReactNode } from 'react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { Route as OpenRoute } from '../routes/_open.tsx'
import { AppTabShell, TabBar } from './tab-bar.tsx'
import { TABS } from './tabs.ts'

const Stub = (): JSX.Element => <div>stub</div>

/**
 * Mount `<TabBar>` inside a minimal router whose tree mirrors the real
 * tab destinations — plus a `/collector/detail` descendant so the
 * exact-or-prefix active matching can be exercised. The root renders the
 * bar above an `<Outlet>` so the matched leaf is a real (non-404) match;
 * active state is derived from the router location, not the rendered
 * leaf.
 */
const renderTabBarAt = (initialPath: string): void => {
  const rootRoute = createRootRoute({
    component: (): JSX.Element => (
      <>
        <TabBar />
        <Outlet />
      </>
    ),
  })
  const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/home', component: Stub })
  const collectorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/collector',
    component: (): JSX.Element => <Outlet />,
  })
  const collectorDetailRoute = createRoute({
    getParentRoute: () => collectorRoute,
    path: '/detail',
    component: Stub,
  })
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: Stub,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      homeRoute,
      collectorRoute.addChildren([collectorDetailRoute]),
      settingsRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  render(<RouterProvider router={router} />)
}

// Each test mounts its own router; clear the prior tree so `getByRole`
// queries don't trip over a leftover tab bar from the previous render.
afterEach(() => {
  cleanup()
})

describe('TabBar', () => {
  test('renders a link to every tab destination, labelled and ordered as configured', async () => {
    renderTabBarAt('/home')
    const links = await screen.findAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual(TABS.map((t) => t.label))
    for (const tab of TABS) {
      expect(screen.getByRole('link', { name: tab.label }).getAttribute('href')).toBe(tab.path)
    }
  })

  test('marks only the current tab with aria-current="page"', async () => {
    renderTabBarAt('/collector')
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Collector' }).getAttribute('aria-current')).toBe(
        'page'
      )
    })
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBeNull()
  })

  test('keeps the tab active on a descendant route (prefix match)', async () => {
    renderTabBarAt('/collector/detail')
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Collector' }).getAttribute('aria-current')).toBe(
        'page'
      )
    })
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull()
  })
})

/** Mount `<AppTabShell>` (which renders `<TabBar>`, so it needs a router) at `/`. */
const renderShell = (child: ReactNode): void => {
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: (): JSX.Element => <AppTabShell>{child}</AppTabShell>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router} />)
}

describe('AppTabShell', () => {
  test('renders children in the content region with the Primary bar as a content-then-bar sibling', async () => {
    renderShell(<p data-testid="shell-child">hello</p>)
    const child = await screen.findByTestId('shell-child')
    // `getByRole` throws on multiple, so this also pins that exactly one
    // Primary nav renders.
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    // The child lives in the content column, not inside the nav.
    expect(nav.contains(child)).toBe(false)
    // DOM order is content-then-bar — the responsive `order: -1` flip
    // relies on this so tab/a11y order stays correct on narrow screens.
    expect(child.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('tab bar scope', () => {
  test('the public _open subtree mounts no Primary tab bar', async () => {
    // Guards the scope boundary: the device-login surface must stay
    // unauthenticated-clean. Renders the real `_open` layout component
    // (a bare passthrough) over a stub device route — if a future edit
    // wraps `_open` in `AppTabShell`, the Primary nav would leak here.
    const rootRoute = createRootRoute()
    const openRoute = createRoute({
      getParentRoute: () => rootRoute,
      id: '_open',
      component: OpenRoute.options.component,
    })
    const deviceRoute = createRoute({
      getParentRoute: () => openRoute,
      path: '/device',
      component: (): JSX.Element => <div>device login</div>,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([openRoute.addChildren([deviceRoute])]),
      history: createMemoryHistory({ initialEntries: ['/device'] }),
    })
    render(<RouterProvider router={router} />)
    await screen.findByText('device login')
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull()
  })
})
