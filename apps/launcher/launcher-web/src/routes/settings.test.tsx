import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  TELEMETRY_CONSENT_COPY,
  WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY,
} from '@wildflowerhealthio/branding-core'
import {
  gatekeeperLogoutSettingsItem,
  makeBearerAuthStateStore,
} from '@wildflowerhealthio/gatekeeper-react'
import type { SettingsItem } from '@wildflowerhealthio/shared-structures-react'
import { TelemetryConsentGate } from '@wildflowerhealthio/telemetry-react'
import { Option } from 'effect'
import type { JSX } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { LogoutSettingsItemContext } from '../session/logout-settings-item-context.ts'
import {
  openDialog,
  restoreDialogModality,
  storeConsent,
  stubDialogModality,
} from '../session/telemetry-consent.test-helpers.ts'

// The `/settings` auth gate now lives in the route's `beforeLoad`
// (shared `wildflowerRouteOptions`), not inside `SettingsLayout` — so
// the component renders the page shell + `<Outlet>` unconditionally. The
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
const renderSettingsScreen = (appSettingsItems: readonly SettingsItem[] = []): void => {
  const rootRoute = createRootRoute({ component: SettingsLayout })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <SettingsIndex appSettingsItems={appSettingsItems} />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router} />)
}

/**
 * Links contributed by the slice rows only — not the header's back link, and
 * not the Legal rows the index ends on, absolute links to the policy pages on
 * the canonical site, which would otherwise pollute the "/settings/<slice>"
 * assertions below.
 */
const sliceRowLinks = (): readonly HTMLAnchorElement[] =>
  screen
    .getAllByRole('link')
    .filter(
      (link): link is HTMLAnchorElement =>
        link.closest('li') !== null && !(link.getAttribute('href') ?? '').startsWith('https://')
    )

/** An in-memory stand-in for the tab's `sessionStorage`. */
const sessionStorageStub = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const entries = new Map<string, string>()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
  }
}

/** Wait for the index to render, by its single "Settings" heading. */
const findSettingsHeading = (): Promise<HTMLElement> =>
  screen.findByRole('heading', { name: 'Settings', level: 1 })

// Clear each mounted tree so the single-match `getByRole` lookups don't see
// duplicates across tests.
afterEach(() => {
  cleanup()
})

describe('SettingsScreen', () => {
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

  test('aggregates one row per participating slice (databases, gatekeeper)', async () => {
    renderSettingsScreen()
    await waitFor(() => {
      expect(screen.getAllByText('Your data').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('Access').length).toBeGreaterThanOrEqual(1)
    })
  })

  test('every slice row but Arrange home screen links into /settings/<slice>/', async () => {
    renderSettingsScreen()
    await findSettingsHeading()
    const arrange = screen.getByRole('link', { name: /Arrange home screen/ })
    const links = sliceRowLinks().filter((link) => link !== arrange)
    expect(links.length).toBeGreaterThanOrEqual(2)
    for (const link of links) {
      const href = link.getAttribute('href') ?? ''
      expect(href.startsWith('/settings/')).toBe(true)
    }
  })

  test('leads back to the apps home, which links here from its gear', async () => {
    renderSettingsScreen()
    await findSettingsHeading()
    expect(screen.getByRole('link', { name: 'Apps' }).getAttribute('href')).toBe('/home')
  })

  test('links Arrange home screen to the home screen in edit mode', async () => {
    renderSettingsScreen()
    await findSettingsHeading()
    const arrange = screen.getByRole('link', { name: /Arrange home screen/ })
    expect(arrange.getAttribute('href')).toBe('/home?edit=true')
  })

  test('ends on the Legal rows, each opening a policy page on the canonical site in a new tab', async () => {
    renderSettingsScreen()
    await findSettingsHeading()
    for (const [name, href] of [
      ['Privacy policy', 'https://wildflowerhealth.io/privacy-policy/'],
      ['Consumer health data', 'https://wildflowerhealth.io/consumer-health-data/'],
      ['Terms of use', 'https://wildflowerhealth.io/terms/'],
      ['Deleting your data', 'https://wildflowerhealth.io/deletion/'],
    ] as const) {
      const link = screen.getByRole('link', { name })
      expect(link.getAttribute('href')).toBe(href)
      expect(link.getAttribute('target')).toBe('_blank')
    }
  })

  test('each slice item links to its declared href', async () => {
    renderSettingsScreen()
    await waitFor(() => {
      const hrefs = new Set(sliceRowLinks().map((l) => l.getAttribute('href') ?? ''))
      expect(hrefs.has('/settings/databases')).toBe(true)
      expect(hrefs.has('/settings/gatekeeper')).toBe(true)
    })
  })

  test('renders the logout row as a button that logs the session out', async () => {
    // The logout row is an action row: the page holds its bearer in memory, so
    // logging out means forgetting it and revoking it with an authenticated
    // request.
    const store = makeBearerAuthStateStore(sessionStorageStub(), 'test.signed-in-server')
    store.writeSession({ serverUrl: 'https://abc.tunnel.example', bearer: 'eyJ.owner.token' })
    const left = Promise.withResolvers<undefined>()
    renderSettingsScreen([
      gatekeeperLogoutSettingsItem({
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
})

describe('the settings route’s Logout row', () => {
  test('is the row the app provides', async () => {
    // Arrange
    const logout: SettingsItem = { id: 'logout', title: 'Logout', onClick: () => {} }
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

    // Act
    render(
      <LogoutSettingsItemContext value={Option.some(logout)}>
        <RouterProvider router={router} />
      </LogoutSettingsItemContext>
    )

    // Assert
    expect(await screen.findByRole('button', { name: /Logout/ })).toBeDefined()
  })
})

describe('the settings route’s Telemetry row', () => {
  /**
   * Mount the `/settings` layout over the real route binding, which reads the
   * app's rows, optionally inside the consent gate `main-web` mounts.
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

  test('shows the answer inside the consent gate, and reopens the dialog', async () => {
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

  test('reads the answer by the switch labels of the copy its gate shows', async () => {
    // Arrange — the host's copy, its labels changed so only it can name them
    const hostCopy = {
      ...WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY,
      crashReports: { ...WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY.crashReports, label: 'Errors' },
      performance: { ...WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY.performance, label: 'Timings' },
    }
    storeConsent({ crashReports: false, performance: true })

    // Act
    renderSettingsRoute((screenTree) => (
      <TelemetryConsentGate copy={hostCopy} onDecided={vi.fn()}>
        {screenTree}
      </TelemetryConsentGate>
    ))

    // Assert
    expect(
      await screen.findByRole('button', {
        name: (accessibleName) =>
          accessibleName.startsWith('Telemetry') &&
          accessibleName.endsWith('Errors off · Timings on'),
      })
    ).toBeDefined()
  })

  test('is absent outside a consent gate', async () => {
    // Arrange / Act
    renderSettingsRoute((screenTree) => screenTree)

    // Assert — the page renders, with no Telemetry row
    await screen.findByRole('heading', { name: 'Settings', level: 1 })
    expect(screen.queryByRole('button', { name: /^Telemetry/ })).toBeNull()
    expect(screen.queryByText('Telemetry')).toBeNull()
  })
})
