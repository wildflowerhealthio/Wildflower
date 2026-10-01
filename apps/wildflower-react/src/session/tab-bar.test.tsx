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
import { PlatformTabsProvider } from './platform-tabs.tsx'
import { ServerKind, ServerKindContext } from './server-kind.ts'
import { AppTabShell, TabBar } from './tab-bar.tsx'
import {
  COLLECTOR_TAB,
  HOME_TAB,
  PLAIN_SMART_HOME_TAB,
  SETTINGS_TAB,
  type TabSpec,
} from './tabs.ts'

const Stub = (): JSX.Element => <div>stub</div>

/**
 * Mount `<TabBar>` inside a minimal router whose tree mirrors the real
 * tab destinations — plus a `/collector/detail` descendant so the
 * exact-or-prefix active matching can be exercised. The root renders the
 * bar above an `<Outlet>` so the matched leaf is a real (non-404) match;
 * active state is derived from the router location, not the rendered
 * leaf. `serverKind` is the tree's, a Wildflower server's unless given.
 */
const renderTabBarAt = (
  initialPath: string,
  platformTabs: readonly TabSpec[] = [],
  serverKind: ServerKind = ServerKind.Wildflower()
): void => {
  const rootRoute = createRootRoute({
    component: (): JSX.Element => (
      <>
        <TabBar />
        <Outlet />
      </>
    ),
  })
  const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/home', component: Stub })
  const fhirHomeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/fhir-home',
    component: Stub,
  })
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
  const harRecorderRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/har-recorder',
    component: Stub,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      homeRoute,
      fhirHomeRoute,
      collectorRoute.addChildren([collectorDetailRoute]),
      settingsRoute,
      harRecorderRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  render(
    <ServerKindContext value={serverKind}>
      <PlatformTabsProvider tabs={platformTabs}>
        <RouterProvider router={router} />
      </PlatformTabsProvider>
    </ServerKindContext>
  )
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
    const sharedTabs = [HOME_TAB, COLLECTOR_TAB, SETTINGS_TAB]
    expect(links.map((l) => l.textContent)).toEqual(sharedTabs.map((t) => t.label))
    for (const tab of sharedTabs) {
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

  test('renders an entry-contributed platform tab between collector and settings', async () => {
    renderTabBarAt('/home', [{ key: 'har-recorder', label: 'HAR Recorder', path: '/har-recorder' }])
    const links = await screen.findAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual([
      'Home',
      'Collector',
      'HAR Recorder',
      'Settings',
    ])
    expect(screen.getByRole('link', { name: 'HAR Recorder' }).getAttribute('href')).toBe(
      '/har-recorder'
    )
  })

  test('renders no platform tab when the entry contributes none', async () => {
    renderTabBarAt('/home')
    const links = await screen.findAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual(['Home', 'Collector', 'Settings'])
    expect(screen.queryByRole('link', { name: 'HAR Recorder' })).toBeNull()
  })

  test('renders only Home, at the plain SMART Home, on a plain SMART server', async () => {
    // The entry's platform tab is withheld too: every surface but Home calls
    // Wildflower-only endpoints.
    renderTabBarAt(
      '/fhir-home',
      [{ key: 'har-recorder', label: 'HAR Recorder', path: '/har-recorder' }],
      ServerKind.PlainSmart({ fhirBaseUrl: 'https://launcher.test/fhir', patient: undefined })
    )
    const links = await screen.findAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual([PLAIN_SMART_HOME_TAB.label])
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/fhir-home')
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page')
    })
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
