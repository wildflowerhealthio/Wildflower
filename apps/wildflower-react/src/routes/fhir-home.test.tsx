import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, within } from '@testing-library/react'
import { APP_DESCRIPTIONS, smartAppLaunchPages } from 'branding-core'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { ServerKind, ServerKindContext } from '../session/server-kind.ts'
import { FhirServerHome } from './fhir-home.tsx'

/** The SMART Health IT launcher's "Launch as logged in patient" demo server. */
const LAUNCHER_FHIR_BASE_URL =
  'https://launch.smarthealthit.org/v/r4/sim/WzMsIjZiMjIzZjg5LWU3MjYtNDRkYS04MWFkLTAzZDMwZmM2MTI1NCIsImR0ci1wcmFjdC0yIiwiQVVUTyIsMSwwLDAsIiIsIiIsIiIsIiIsIiIsIiIsIiIsMCwyLCIiXQ/fhir'

/** A plain SMART server that is not the launcher. */
const OTHER_FHIR_BASE_URL = 'https://fhir.example.org/r4'

/** A PR preview's site root, so the links are seen to follow it. */
const PREVIEW_SITE_ROOT = 'https://wildflowerhealthio.github.io/staging/pr-7/'

/**
 * Mount {@link FhirServerHome} at `/fhir-home` inside a minimal router (its tab
 * bar renders links), in a tree built for a plain SMART server — what
 * `main-web` provides once such a sign-in redeems.
 */
const renderFhirServerHome = (
  server: { readonly fhirBaseUrl: string; readonly patient: string | undefined } = {
    fhirBaseUrl: LAUNCHER_FHIR_BASE_URL,
    patient: undefined,
  }
): void => {
  const rootRoute = createRootRoute()
  const fhirHomeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/fhir-home',
    component: () => <FhirServerHome server={server} siteRoot={PREVIEW_SITE_ROOT} />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([fhirHomeRoute]),
    history: createMemoryHistory({ initialEntries: ['/fhir-home'] }),
  })
  render(
    <ServerKindContext value={ServerKind.PlainSmart(server)}>
      <RouterProvider router={router} />
    </ServerKindContext>
  )
}

/** The app tiles' links, in the order the page lists them. */
const findAppLinks = async (): Promise<readonly HTMLAnchorElement[]> => {
  const appList = await screen.findByRole('list', { name: 'Apps' })
  return within(appList).getAllByRole<HTMLAnchorElement>('link')
}

afterEach(() => {
  cleanup()
})

describe('FhirServerHome', () => {
  test('says the server is a plain SMART server, naming its FHIR base', async () => {
    // Act
    renderFhirServerHome()

    // Assert
    await screen.findByRole('heading', { name: 'Home' })
    expect(screen.getByText(LAUNCHER_FHIR_BASE_URL)).toBeDefined()
    expect(screen.getByText(/rather than a Wildflower server/)).toBeDefined()
  })

  test('sits in the tab shell with Home as its only tab', async () => {
    // Act
    renderFhirServerHome()

    // Assert
    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const links = Array.from(nav.querySelectorAll('a'))
    expect(links.map((link) => link.textContent)).toEqual(['Home'])
  })

  test('lists every hosted SMART app, by name and tagline, and nothing else', async () => {
    // Act
    renderFhirServerHome()

    // Assert
    const appLinks = await findAppLinks()
    const appTiles = appLinks.map((link) => link.textContent)
    expect(appTiles).toStrictEqual(
      smartAppLaunchPages(PREVIEW_SITE_ROOT).map(
        ({ app }) => `${APP_DESCRIPTIONS[app].name}${APP_DESCRIPTIONS[app].tagline}`
      )
    )
    expect(appTiles).toHaveLength(5)
    expect(screen.queryByRole('link', { name: /FHIR Sync for Pebble/ })).toBeNull()
  })

  test("links each app's launch page on the site root it is given", async () => {
    // Act
    renderFhirServerHome()

    // Assert
    const appLinks = await findAppLinks()
    expect(appLinks.map((link) => link.href.split('?')[0])).toStrictEqual([
      `${PREVIEW_SITE_ROOT}medications-app/launch.html`,
      `${PREVIEW_SITE_ROOT}importer-app/launch.html`,
      `${PREVIEW_SITE_ROOT}web-trace-app/launch.html`,
      `${PREVIEW_SITE_ROOT}health-viewer-app/launch.html`,
      `${PREVIEW_SITE_ROOT}synthetic-data-app/launch.html`,
    ])
  })

  test("EHR-launches each app through the launcher on one of its servers, with the session's patient", async () => {
    // Arrange
    const patient = '6b223f89-e726-44da-81ad-03d30fc61254'

    // Act
    renderFhirServerHome({ fhirBaseUrl: LAUNCHER_FHIR_BASE_URL, patient })

    // Assert
    for (const link of await findAppLinks()) {
      const launchSearch = new URL(link.href).searchParams
      expect(launchSearch.get('iss')).toBe('https://launch.smarthealthit.org/v/r4/fhir')
      const launchCode = launchSearch.get('launch') ?? ''
      expect(Buffer.from(launchCode, 'base64url').toString('utf8')).toContain(`"${patient}"`)
    }
  })

  test('standalone-launches each app against any other server', async () => {
    // Act
    renderFhirServerHome({ fhirBaseUrl: OTHER_FHIR_BASE_URL, patient: 'example' })

    // Assert
    for (const link of await findAppLinks()) {
      const launchSearch = new URL(link.href).searchParams
      expect([...launchSearch.entries()]).toStrictEqual([['iss', OTHER_FHIR_BASE_URL]])
    }
  })
})
