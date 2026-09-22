import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { serverUrlFromSearch } from 'gatekeeper-core/smart-client'
import { makeBearerAuthStateStore, type BearerAuthStateStore } from 'gatekeeper-react'
import { AuthedUntil, AuthStateProvider } from 'react-kitchen-sink'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { DEFAULT_SERVER_URL } from '../web-entry.ts'
import { Landing } from './index.tsx'

/**
 * The landing page is the whole entry point for `main-web` — the only screen an
 * unauthed reader can reach, and the one that starts the SMART redirect. These
 * pin what it offers before and after a server is chosen, and that an
 * already-signed-in reader is sent on rather than left sitting here.
 *
 * The component reads `window.location.search` directly (that is where
 * `?server=` lives on a real load), so each test points jsdom at the URL under
 * test rather than passing one in.
 */
describe('Landing', () => {
  afterEach(() => {
    cleanup()
  })

  test('offers the server picker but no sign-in until a server is chosen', async () => {
    // Arrange / Act — a bare visit, before any server has been picked.
    await mountLanding('/')

    // Assert — signing in needs a target, so the call to action is absent.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /local server/i })).toBeDefined()
    })
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull()
  })

  test('offers sign-in to the server already named by ?server=', async () => {
    // Arrange / Act — a reader who arrived on a shared link, or who was bounced
    // here by the auth gate, has nothing to pick and just needs the way in.
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080')

    // Assert — the target is named on the control, so the reader can see which
    // server they are about to hand a token to.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /sign in to http:\/\/127\.0\.0\.1:8080/i })
      ).toBeDefined()
    })
  })

  test('shows a sign-in that failed before the tree existed', async () => {
    // Arrange / Act — the boot-time redemption failed, so `main-web` threaded
    // the reason in rather than leaving the reader with a silent bounce.
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', {
      bootSignInProblem: 'The token request was rejected: invalid_grant.',
    })

    // Assert
    await waitFor(() => {
      expect(screen.getByText(/invalid_grant/)).toBeDefined()
    })
  })

  test('sends an already-signed-in reader on to the app', async () => {
    // Arrange — authed before the router mounts, which is what `main-web`'s
    // boot does after it redeems a callback.
    const store = makeBearerAuthStateStore()
    store.writeBearer('tok_web')
    store.setAuthState(AuthedUntil({ exp: Math.floor(Date.now() / 1000) + 3600 }))

    // Act
    const router = await mountLanding('/', { store })

    // Assert — the bounce runs in an effect, so it lands after a tick. Done in
    // the render body it could be dropped, leaving a signed-in reader parked on
    // the picker.
    await waitFor(() => {
      expect(router.pathname()).toBe('/home')
    })
  })

  test('keeps the served subpath when a server is chosen', async () => {
    // Arrange — the hosted build is served under a subpath, not the origin root.
    const appBase = '/staging/pr-719/app/'
    await mountLanding(appBase, { basepath: appBase })

    // Act — picking the local server records `?server=` in the address bar. The
    // record is written synchronously, before the sign-in redirect leaves.
    fireEvent.click(await screen.findByRole('button', { name: /local server/i }))

    // Assert — the reader stays on the app's own subpath (not moved to `/`), and
    // `?server=` is now set there. A root path would point the parameter at a
    // page that is not this app.
    expect(window.location.pathname).toBe(appBase)
    expect(serverUrlFromSearch(window.location.search)).toBe(DEFAULT_SERVER_URL)
  })
})

// Helpers

/**
 * Mount the landing page at `url` under a minimal router carrying a `/home`
 * stub for the bounce to land on. jsdom's address is set to the same `url`,
 * since the component reads `window.location.search` for `?server=`.
 */
const mountLanding = async (
  url: string,
  options: {
    readonly store?: BearerAuthStateStore
    readonly bootSignInProblem?: string
    /**
     * Router basepath, when `url` is under a subpath rather than the origin
     * root — mirrors what `main-web` passes so `/` still resolves the landing
     * there. See `web-basepath.test.tsx`.
     */
    readonly basepath?: string
  } = {}
): Promise<{ readonly pathname: () => string }> => {
  window.history.replaceState(null, '', url)

  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <Landing bootSignInProblem={options.bootSignInProblem} />,
  })
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/home',
    component: () => <p>home</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, homeRoute]),
    basepath: options.basepath,
    history: createMemoryHistory({ initialEntries: [url] }),
  })

  render(
    <AuthStateProvider store={options.store ?? makeBearerAuthStateStore()}>
      <RouterProvider router={router} />
    </AuthStateProvider>
  )
  await waitFor(() => {
    expect(router.state.status).toBe('idle')
  })
  return { pathname: () => router.state.location.pathname }
}
