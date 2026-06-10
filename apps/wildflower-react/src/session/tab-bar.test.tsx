import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { TabBar } from './tab-bar.tsx'
import { TABS } from './tab-mapping.ts'

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
