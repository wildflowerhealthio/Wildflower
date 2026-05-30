import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vite-plus/test'

// `SettingsLayout` gates its content behind `RequireAuth`, which reads a
// live bearer token off `<AuthTokenProvider>` and renders `NeedsAuthMessage`
// until one arrives. Auth gating is exercised in RequireAuth's own tests; here
// it's noise, so the gate is mocked to a transparent passthrough — the same
// "mock the concern that isn't under test" approach the RootShell test uses.
// The factory returns `children` directly (no JSX) because `vi.mock` is
// hoisted above the file's imports, so the JSX runtime isn't in scope yet.
vi.mock('../session/require-auth.tsx', () => ({
  RequireAuth: ({ children }: { readonly children: ReactNode }): ReactNode => children,
}))

// Dynamic import AFTER the `vi.mock` call so the passthrough is registered
// before `SettingsLayout` pulls in `RequireAuth`.
const { SettingsLayout } = await import('./settings.tsx')
const { SettingsIndex } = await import('./settings/index.tsx')

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
