import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TELEMETRY_CONSENT_COPY } from 'branding-core'
import { gatekeeperLogoutSettingsItem, makeBearerAuthStateStore } from 'gatekeeper-react'
import type { JSX } from 'react'
import type { SettingsItem } from 'shared-structures-react'
import { TelemetryConsentGate } from 'telemetry-react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  openDialog,
  restoreDialogModality,
  storeConsent,
  stubDialogModality,
} from '../session/telemetry-consent.test-helpers.ts'

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
import { SettingsIndex, SettingsIndexRoute } from './settings/index.tsx'

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
    // It is an action row: the page holds its bearer in memory, so logging
    // out means forgetting it and revoking it with an authenticated request.
    const store = makeBearerAuthStateStore()
    store.writeBearer('eyJ.owner.token')
    const left = Promise.withResolvers<undefined>()
    renderSettingsScreen([
      gatekeeperLogoutSettingsItem({
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

describe('the settings route’s Telemetry row', () => {
  /**
   * Mount the `/settings` layout over the real route binding, which reads the
   * entry's rows, optionally inside the consent gate `main-web` mounts.
   */
  const renderSettingsRoute = (wrap: (screenTree: JSX.Element) => JSX.Element): void => {
    const rootRoute = createRootRoute({ component: SettingsLayout })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: SettingsIndexRoute,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(wrap(<RouterProvider router={router} />))
  }

  afterEach(() => {
    window.localStorage.clear()
    restoreDialogModality()
  })

  test('shows the answer inside the web entry’s consent gate, and reopens the dialog', async () => {
    // Arrange
    stubDialogModality()
    storeConsent({ crashReports: true, performance: false })
    renderSettingsRoute((screenTree) => (
      <TelemetryConsentGate copy={TELEMETRY_CONSENT_COPY} onDecided={vi.fn()}>
        {screenTree}
      </TelemetryConsentGate>
    ))
    const summary = `${TELEMETRY_CONSENT_COPY.crashReports.label} on · ${TELEMETRY_CONSENT_COPY.performance.label} off`
    const row = await screen.findByRole('button', {
      name: (accessibleName) =>
        accessibleName.startsWith('Telemetry') && accessibleName.endsWith(summary),
    })
    expect(openDialog()).toBeNull()

    // Act
    fireEvent.click(row)

    // Assert
    expect(openDialog()).not.toBeNull()
  })

  test('is absent outside a consent gate, as on the Tauri entry', async () => {
    // Arrange / Act
    renderSettingsRoute((screenTree) => screenTree)

    // Assert — the page renders, with no Telemetry row
    await screen.findByRole('heading', { name: 'Settings', level: 1 })
    expect(screen.queryByRole('button', { name: /^Telemetry/ })).toBeNull()
    expect(screen.queryByText('Telemetry')).toBeNull()
  })
})
