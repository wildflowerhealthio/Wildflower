import { HttpClientError, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import {
  type BearerAuthStateStore,
  makeBearerAuthStateStore,
} from '@wildflowerhealthio/authorization-react'
import {
  AuthedExpiryUnknown,
  AuthStateProvider,
  isAuthed,
} from '@wildflowerhealthio/react-kitchen-sink'
import { Effect } from 'effect'
import type { JSX, ReactNode } from 'react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { renderScopeError } from './scope-error-renderer.tsx'
import { RETURN_TO_PARAM } from './sign-in.ts'

/**
 * Pins the app's `403 InsufficientScope` wiring end-to-end: which errors get the
 * bespoke surface at all, and — the step-up leg (resource-authorization epic
 * child ⑤) — that "Request access" signs in again: the session drops, and the
 * reader lands on the landing carrying where the denial happened, so the new
 * sign-in's return trip re-runs the denied action.
 *
 * Driven through a real router rather than a mocked `useNavigate`: the assertion
 * is about the resulting location (path + both search params), which a stubbed
 * navigate would delete.
 */

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
})

/** Where the denial happens in these tests. */
const DENIED_PATH = '/settings/databases'

/** A decoded `403 InsufficientScope` body — what a *declared* 403 surfaces. */
const insufficientScopeBody = (missingScopes: readonly string[]): unknown => ({
  error: 'InsufficientScope',
  missingScopes,
})

/** A bare `403 ResponseError` — the *undeclared* 403, whose body was never decoded. */
const undeclaredForbidden = (): HttpClientError.ResponseError => {
  const request = HttpClientRequest.get('/fixture')
  return new HttpClientError.ResponseError({
    request,
    response: HttpClientResponse.fromWeb(request, new Response(null, { status: 403 })),
    reason: 'StatusCode',
  })
}

/** A signed-in session, as `main-web` holds one after a sign-in redeems. */
const signedInStore = (): BearerAuthStateStore => {
  const store = makeBearerAuthStateStore(window.sessionStorage, 'scope-error-renderer.test.server')
  store.writeSession({ serverUrl: 'https://ruth.wildflowerhealth.io', bearer: 'tok_narrow' })
  store.setAuthState(AuthedExpiryUnknown())
  return store
}

/**
 * Mount whatever `renderScopeError` produced for `error` at {@link DENIED_PATH},
 * under `store`'s session, inside a router that also carries the landing so the
 * step-up navigation resolves to a live route instead of a 404. Returns the
 * router so assertions can read the location the click produced.
 */
const renderErrorAt = (
  error: unknown,
  store: BearerAuthStateStore = signedInStore()
): AnyRouter => {
  const rootRoute = createRootRoute({ component: (): JSX.Element => <Outlet /> })
  const deniedRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: DENIED_PATH,
    component: (): ReactNode => renderScopeError(error),
  })
  const landingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: (): JSX.Element => <div>landing</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([deniedRoute, landingRoute]),
    history: createMemoryHistory({ initialEntries: [DENIED_PATH] }),
  })
  render(
    <AuthStateProvider store={store}>
      <RouterProvider router={router} />
    </AuthStateProvider>
  )
  return router
}

describe('renderScopeError', () => {
  test('declines anything that is not an authorization failure', () => {
    // Falling through to `null` is what lets the default error rendering handle
    // every other failure — a surface that swallowed them would hide real errors.
    expect(renderScopeError(new Error('boom'))).toBeNull()
    expect(renderScopeError(undefined)).toBeNull()
  })

  test('names the missing scopes in plain language', async () => {
    renderErrorAt(insufficientScopeBody(['wildflower/Grant.d']))
    expect(await screen.findByText('delete Grants')).toBeTruthy()
  })
})

describe('step-up action', () => {
  test('signs in again, returning to where the denial happened', async () => {
    const store = signedInStore()
    const router = renderErrorAt(
      insufficientScopeBody(['wildflower/Grant.d', 'wildflower/Grant.r']),
      store
    )

    await userEvent.click(await screen.findByRole('button', { name: /request access/i }))

    // The landing signs in to the session's server on arrival; `returnTo` is
    // where the denial happened, so the redeemed sign-in re-runs the denied
    // loader.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/')
    })
    const search = new URLSearchParams(router.state.location.href.split('?')[1] ?? '')
    expect(search.get(RETURN_TO_PARAM)).toBe(DENIED_PATH)
    // The narrow session goes, or the landing would send the reader straight
    // on to `/home`; its server stays, for the landing to sign back in to.
    expect(isAuthed(Effect.runSync(store.subscribable.get))).toBe(false)
    expect(store.bearer()).toBeUndefined()
    expect(store.serverUrl()).toBe('https://ruth.wildflowerhealth.io')
  })

  test('is not offered when the 403 named no scopes', async () => {
    // The undeclared-403 path: with no named permission to ask for, the
    // surface stays a read-only explanation.
    renderErrorAt(undeclaredForbidden())
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /request access/i })).toBeNull()
  })
})
