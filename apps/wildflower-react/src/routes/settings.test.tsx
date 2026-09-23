import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeBearerAuthStateStore } from 'gatekeeper-react'
import type { SettingsItem } from 'shared-structures-react'
import { afterEach, describe, expect, test } from 'vite-plus/test'
import { makeBearerLogoutSettingsItem } from '../bearer-logout.ts'

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
const renderSettingsScreen = (platformSettingsItems: readonly SettingsItem[] = []): void => {
  const rootRoute = createRootRoute({ component: SettingsLayout })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <SettingsIndex platformSettingsItems={platformSettingsItems} />,
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

  test('every slice row links into /settings/<slice>/', async () => {
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

  test('renders main-web’s logout row as a button that logs the session out', async () => {
    // `main-web` threads its bearer logout row into `platformSettingsItems`.
    // It is an action row: the page holds a bearer, not a cookie, so a
    // same-origin form post would carry no credential and log nothing out.
    const store = makeBearerAuthStateStore()
    store.writeBearer('eyJ.owner.token')
    const left = Promise.withResolvers<undefined>()
    renderSettingsScreen([
      makeBearerLogoutSettingsItem({
        apiBaseUrl: 'https://abc.tunnel.example',
        bearerStore: store,
        fetch: () => Promise.resolve(new Response(null, { status: 204 })),
        leave: () => left.resolve(undefined),
      }),
    ])
    const button = await screen.findByRole('button', { name: /Logout/ })
    expect(button.closest('form')).toBeNull()
    fireEvent.click(button)
    await left.promise
    expect(store.bearer()).toBeUndefined()
  })

  test('omits the logout row when the entry contributes no platform items', async () => {
    // `main-tauri` passes `platformSettingsItems: []` — the host authenticates
    // the webview by connection provenance, so there is nothing to log out of.
    renderSettingsScreen([])
    await screen.findByRole('navigation', { name: 'Primary' })
    expect(screen.queryByRole('button', { name: /Logout/ })).toBeNull()
  })
})
