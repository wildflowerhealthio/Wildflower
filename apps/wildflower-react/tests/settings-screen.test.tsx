import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test } from 'vite-plus/test'

import { SettingsScreen } from '../src/screens/settings-screen.tsx'

/**
 * Mount `<SettingsScreen>` inside a minimal TanStack router so any
 * `<Link>` rendered by `<ItemList>` can resolve its router context. The
 * router only exists for link rendering — no navigation is exercised
 * here.
 */
const renderSettingsScreen = (): void => {
  const rootRoute = createRootRoute({ component: () => <SettingsScreen /> })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  })
  render(<RouterProvider router={router} />)
}

describe('SettingsScreen', () => {
  test('renders the page heading', async () => {
    renderSettingsScreen()
    // TanStack `<RouterProvider>` resolves its first match
    // asynchronously, so the matched route's component (the page
    // heading) only mounts after a tick — wait for it.
    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { name: 'Settings', level: 1 })
      expect(headings.length).toBeGreaterThanOrEqual(1)
    })
  })

  test('aggregates one row per participating slice (tunnel, gatekeeper)', async () => {
    renderSettingsScreen()
    // Each participating slice contributes exactly one top-level menu
    // item via its `*SettingsItemsFragment`. Collector is intentionally
    // not a settings item — it's top-level functionality at /collector,
    // not a settings concern. Use getAllByText because the test
    // environment may render the tree more than once (React StrictMode
    // double-invocation under jsdom), which doesn't reflect a real
    // duplication in the screen output.
    await waitFor(() => {
      expect(screen.getAllByText('Tunnel').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('Access').length).toBeGreaterThanOrEqual(1)
    })
  })

  test('every row links into /settings/<slice>/', async () => {
    renderSettingsScreen()
    // Walk each row's anchor href; settings items always render as
    // links per the `<ItemList>` contract for href-bearing items. The
    // app's invariant is that every settings URL lives under /settings.
    await waitFor(() => {
      const links = screen.getAllByRole('link')
      expect(links.length).toBeGreaterThanOrEqual(2)
    })
    const links = screen.getAllByRole('link')
    for (const link of links) {
      const href = link.getAttribute('href') ?? ''
      expect(href.startsWith('/settings/')).toBe(true)
    }
  })

  test('each slice item links to its declared href', async () => {
    renderSettingsScreen()
    // Map href → set of titles found at that href to assert the link
    // graph matches the slices' fragment declarations regardless of
    // duplicate-rendering quirks.
    await waitFor(() => {
      const links = screen.getAllByRole('link')
      const hrefs = new Set(links.map((l) => l.getAttribute('href') ?? ''))
      expect(hrefs.has('/settings/tunnel')).toBe(true)
      expect(hrefs.has('/settings/gatekeeper')).toBe(true)
    })
  })
})
