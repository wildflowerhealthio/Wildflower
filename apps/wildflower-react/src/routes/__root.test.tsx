import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { SERVER_QUERY_PARAM } from 'gatekeeper-core/smart-client'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { rootSearchOptions } from './__root.tsx'

describe('rootSearchOptions', () => {
  afterEach(() => {
    cleanup()
  })

  it('should keep ?server= on a navigation that does not mention it', async () => {
    // Arrange — signed in against a named server, on the home screen.
    const router = mountAt('/home?server=https%3A%2F%2Fruth.wildflowerhealth.io')

    // Act — an in-app navigation that sets no search of its own.
    await router.goToSettings()

    // Assert — the address still names the server, so a reload stays on it.
    expect(router.search()).toEqual({ server: 'https://ruth.wildflowerhealth.io' })
  })

  it('should put ?server= on the links the router builds', async () => {
    // Arrange / Act — a link like a home tile's launch link.
    mountAt('/home?server=https%3A%2F%2Fruth.wildflowerhealth.io')

    // Assert — a new tab opened from it targets the same server.
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe(
        '/settings?server=https%3A%2F%2Fruth.wildflowerhealth.io'
      )
    })
  })

  it('should read the same parameter the web entry reads its server from', () => {
    expect(rootSearchOptions.validateSearch({ [SERVER_QUERY_PARAM]: 'https://x' })).toEqual({
      server: 'https://x',
    })
  })
})

// Helpers

/** A router with the app root's search handling, a link to `/settings`, at `url`. */
const mountAt = (
  url: string
): { readonly goToSettings: () => Promise<void>; readonly search: () => unknown } => {
  const rootRoute = createRootRoute({
    ...rootSearchOptions,
    component: () => (
      <>
        <Link to="/settings">Settings</Link>
        <Outlet />
      </>
    ),
  })
  const home = createRoute({ getParentRoute: () => rootRoute, path: '/home' })
  const settings = createRoute({ getParentRoute: () => rootRoute, path: '/settings' })
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, settings]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  render(<RouterProvider router={router} />)
  return {
    goToSettings: () => router.navigate({ to: '/settings' }),
    search: () => router.state.location.search,
  }
}
