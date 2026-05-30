import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test } from 'vite-plus/test'

// The `/settings` auth gate now lives in the route's `beforeLoad`
// (`authBeforeLoad`), not inside `SettingsLayout` — so the component
// renders its header + `<Outlet>` unconditionally. Auth gating is
// exercised in `auth-gate.test.tsx`; mounting `SettingsLayout` directly
// here bypasses the gate, which is exactly the unit under test.
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

describe('SettingsScreen', () => {
  test('renders the page heading', async () => {
    renderSettingsScreen()
    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { name: 'Settings', level: 1 })
      expect(headings.length).toBeGreaterThanOrEqual(1)
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
    const links = await screen.findAllByRole('link')
    expect(links.length).toBeGreaterThanOrEqual(2)
    for (const link of links) {
      const href = link.getAttribute('href') ?? ''
      expect(href.startsWith('/settings/')).toBe(true)
    }
  })

  test('each slice item links to its declared href', async () => {
    renderSettingsScreen()
    await waitFor(() => {
      const links = screen.getAllByRole('link')
      const hrefs = new Set(links.map((l) => l.getAttribute('href') ?? ''))
      expect(hrefs.has('/settings/tunnel')).toBe(true)
      expect(hrefs.has('/settings/gatekeeper')).toBe(true)
    })
  })
})
