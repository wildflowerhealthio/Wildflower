import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { makeBearerAuthStateStore, type BearerAuthStateStore } from 'gatekeeper-react'
import { AuthedUntil, AuthStateProvider } from 'react-kitchen-sink'
import { afterEach, describe, expect, test } from 'vite-plus/test'

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

  test('does not name the Local Network Access prompt from a plain-http page', async () => {
    // Arrange / Act — a loopback failure on a page served over plain http (the
    // default jsdom origin). That page is not making the public→local jump
    // Chrome guards, so the reason shows but the prompt hint does not — this
    // pins that the surface passes the page's own security through, rather than
    // hard-coding it. The secure-page positive is covered by
    // `local-network-hint.test.ts`.
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', {
      bootSignInProblem: 'Could not reach the server.',
    })

    // Assert
    await waitFor(() => {
      expect(screen.getByText(/Could not reach the server\./)).toBeDefined()
    })
    expect(screen.queryByText(/Local Network Access/)).toBeNull()
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
