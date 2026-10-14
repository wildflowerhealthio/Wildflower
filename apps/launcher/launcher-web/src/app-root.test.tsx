import { HttpClientError, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { useQuery } from '@tanstack/react-query'
import { createBrowserHistory, createRootRoute, createRoute, Outlet } from '@tanstack/react-router'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import {
  type BearerAuthStateStore,
  makeBearerAuthStateStore,
} from '@wildflowerhealthio/authorization-react'
import { AuthedExpiryUnknown } from '@wildflowerhealthio/react-kitchen-sink'
import { Layer } from 'effect'
import type { JSX } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import type * as SignIn from './sign-in.ts'

/**
 * Pins what `buildAppTree` does when an authed request ends in a 401: the
 * reader signs in again, by the SMART sign-in, to the server the session names,
 * and the sign-in carries where they were as its `returnTo`. Driven through the
 * real landing, so the assertion is on the `startSignIn` call the landing's
 * sign-in on arrival makes, not on an intermediate navigation.
 */

/** The page whose request the server turns away. */
const DENIED_PATH = '/settings/databases'

/** The server the session signed in to. */
const SERVER_URL = 'https://ruth.wildflowerhealth.io'

const { startSignIn } = vi.hoisted(() => ({
  // Never settles, so the landing never leaves for a URL jsdom can't open.
  startSignIn: vi.fn(() => new Promise<never>(() => {})),
}))
vi.mock('./sign-in.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof SignIn>()),
  startSignIn,
}))

/** A bare `401 ResponseError`, as an expired or revoked bearer gets back. */
const unauthorized = (): HttpClientError.ResponseError => {
  const request = HttpClientRequest.get('/fixture')
  return new HttpClientError.ResponseError({
    request,
    response: HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })),
    reason: 'StatusCode',
  })
}

/** A page whose one query the server rejects with a 401. */
const DeniedPage = (): JSX.Element => {
  useQuery({ queryKey: ['denied'], queryFn: () => Promise.reject(unauthorized()) })
  return <p>denied page</p>
}

// The real landing at `/`, and the denied page; nothing else of the app.
vi.mock('./routeTree.gen.ts', async () => {
  const { Landing } = await import('./routes/index.tsx')
  const rootRoute = createRootRoute({ component: (): JSX.Element => <Outlet /> })
  const landing = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    // Reads the sign-in problem from router context, as the real route does.
    component: function LandingFromContext(): JSX.Element {
      const problem = landing.useRouteContext({
        select: (context: { signInProblem?: SignIn.SignInProblem }) => context.signInProblem,
      })
      return <Landing {...(problem === undefined ? {} : { bootSignInProblem: problem })} />
    },
  })
  const denied = createRoute({
    getParentRoute: () => rootRoute,
    path: DENIED_PATH,
    component: DeniedPage,
  })
  return { routeTree: rootRoute.addChildren([landing, denied]) }
})

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
  startSignIn.mockClear()
})

/**
 * Render the app signed in to {@link SERVER_URL} on the denied page, the
 * sign-in having redeemed at `signedInAt` when given.
 */
const renderDeniedPage = async (signedInAt?: number): Promise<BearerAuthStateStore> => {
  const { buildAppTree } = await import('./app-root.tsx')
  const { SIGNED_IN_SERVER_KEY } = await import('./web-entry.ts')
  const { ServerKind } = await import('./session/server-kind.ts')
  window.history.replaceState(null, '', DENIED_PATH)
  const tokenStore = makeBearerAuthStateStore(window.sessionStorage, SIGNED_IN_SERVER_KEY)
  tokenStore.writeSession({ serverUrl: SERVER_URL, bearer: 'tok_revoked' })
  tokenStore.setAuthState(AuthedExpiryUnknown())
  await act(async () => {
    render(
      buildAppTree({
        history: createBrowserHistory(),
        tokenStore,
        awaitAuthReady: () => Promise.resolve(),
        effectTelemetryLayer: Layer.empty,
        serverKind: ServerKind.Wildflower(),
        ...(signedInAt === undefined ? {} : { signedInAt }),
      })
    )
  })
  return tokenStore
}

describe('a 401', () => {
  test('starts the SMART sign-in to the session’s server, returning to where the reader was', async () => {
    // Arrange + Act — a signed-in session, on a page whose request 401s.
    const tokenStore = await renderDeniedPage()

    // Assert — one sign-in, to the session's server, carrying the denied page
    // as `returnTo`, with no EHR launch.
    await waitFor(() => {
      expect(startSignIn).toHaveBeenCalledOnce()
    })
    expect(startSignIn).toHaveBeenCalledWith(SERVER_URL, DENIED_PATH, expect.anything(), undefined)
    expect(tokenStore.bearer()).toBeUndefined()
  })

  test('just after a sign-in stops on the landing instead of signing straight back in', async () => {
    // Arrange + Act — the sign-in redeemed a moment ago, and its token 401s.
    const tokenStore = await renderDeniedPage(Date.now())

    // Assert — the landing says why and waits for the reader: a second
    // sign-in would come back to the same 401.
    await waitFor(() => {
      expect(document.body.textContent).toContain('turned away the sign-in that just finished')
    })
    expect(startSignIn).not.toHaveBeenCalled()
    expect(tokenStore.bearer()).toBeUndefined()
  })
})
