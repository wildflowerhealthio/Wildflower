import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

// The `/settings` auth gate now lives in the route's `beforeLoad`
// (shared `authGatedRouteOptions`), not inside `SettingsLayout` — so
// the component renders the tab shell + `<Outlet>` unconditionally. The
// "Settings" heading no longer lives in the layout (which used to stack
// it on top of every child's own header); it's the index page's single
// `<PageHeader>`, so the macro tree below (layout + index) still renders
// exactly one "Settings" h1. The gate's behaviour is exercised in
// `gatekeeper-react`'s `auth-ready.test.ts`; mounting `SettingsLayout`
// directly here bypasses the gate, which is exactly the unit under test.
import { SettingsLayout } from './settings.tsx'
import { SettingsIndex } from './settings/index.tsx'

/**
 * Mount the `/settings` layout + index inside a minimal TanStack router
 * so the macro tree's two screens render together. The router only
 * exists for link rendering — no navigation is exercised here.
 */
const renderSettingsScreen = (): void => {
  const rootRoute = createRootRoute({ component: SettingsLayout })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: SettingsIndex,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router} />)
}

/**
 * Links contributed by the slice rows only — the `SettingsLayout` now
 * also renders the persistent `<TabBar>` (a `Primary` navigation), whose
 * Home/Collector/Settings links would otherwise pollute the
 * "/settings/<slice>" assertions below.
 */
const sliceRowLinks = (): readonly HTMLAnchorElement[] => {
  const tabBar = screen.getByRole('navigation', { name: 'Primary' })
  return screen
    .getAllByRole('link')
    .filter((link): link is HTMLAnchorElement => !tabBar.contains(link))
}

// The screen now renders the persistent tab bar (a `Primary`
// navigation); clear each mounted tree so the single-match `getByRole`
// lookups in `sliceRowLinks` don't see duplicates across tests.
afterEach(() => {
  cleanup()
})

describe('SettingsScreen', () => {
  test('renders the persistent tab bar alongside the page heading', async () => {
    renderSettingsScreen()
    await waitFor(() => {
      const tabBar = screen.getByRole('navigation', { name: 'Primary' })
      expect(within(tabBar).getByRole('link', { name: 'Home' })).toBeDefined()
      expect(within(tabBar).getByRole('link', { name: 'Collector' })).toBeDefined()
    })
  })

  test('renders the page heading', async () => {
    renderSettingsScreen()
    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { name: 'Settings', level: 1 })
      // Exactly one: the index page's single `<PageHeader>`. The layout no
      // longer stacks its own "Settings" h1 on top — a reintroduced layout
      // heading (the double-header this PR removes) must fail this test.
      expect(headings.length).toBe(1)
    })
  })

  test('aggregates one row per participating slice (tunnel, gatekeeper)', async () => {
    renderSettingsScreen()
    await waitFor(() => {
      expect(screen.getAllByText('Tunnel').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('Access').length).toBeGreaterThanOrEqual(1)
    })
  })

  test('every row links into /settings/<slice>/', async () => {
    renderSettingsScreen()
    await screen.findByRole('navigation', { name: 'Primary' })
    const links = sliceRowLinks()
    expect(links.length).toBeGreaterThanOrEqual(2)
    for (const link of links) {
      const href = link.getAttribute('href') ?? ''
      expect(href.startsWith('/settings/')).toBe(true)
    }
  })

  test('each slice item links to its declared href', async () => {
    renderSettingsScreen()
    await waitFor(() => {
      const hrefs = new Set(sliceRowLinks().map((l) => l.getAttribute('href') ?? ''))
      expect(hrefs.has('/settings/tunnel')).toBe(true)
      expect(hrefs.has('/settings/gatekeeper')).toBe(true)
    })
  })
})
