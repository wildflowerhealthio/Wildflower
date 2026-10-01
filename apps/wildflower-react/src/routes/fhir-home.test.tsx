import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { ServerKind, ServerKindContext } from '../session/server-kind.ts'
import { FhirServerHome } from './fhir-home.tsx'

const FHIR_BASE_URL = 'https://launcher.smarthealthit.org/v/r4/fhir'

/**
 * Mount {@link FhirServerHome} at `/fhir-home` inside a minimal router (its tab
 * bar renders links), in a tree built for a plain SMART server — what
 * `main-web` provides once such a sign-in redeems.
 */
const renderFhirServerHome = (): void => {
  const rootRoute = createRootRoute()
  const fhirHomeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/fhir-home',
    component: () => <FhirServerHome fhirBaseUrl={FHIR_BASE_URL} />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([fhirHomeRoute]),
    history: createMemoryHistory({ initialEntries: ['/fhir-home'] }),
  })
  render(
    <ServerKindContext
      value={ServerKind.PlainSmart({ fhirBaseUrl: FHIR_BASE_URL, patient: undefined })}
    >
      <RouterProvider router={router} />
    </ServerKindContext>
  )
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
    expect(screen.getByText(FHIR_BASE_URL)).toBeDefined()
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
})
