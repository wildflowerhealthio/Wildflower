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
import { DEVICE_LOGIN_ROUTE, parseDeviceLoginSearch, parseRequestScopes } from 'gatekeeper-react'
import type { JSX, ReactNode } from 'react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { renderScopeError } from './scope-error-renderer.tsx'

/**
 * Pins the app's `403 InsufficientScope` wiring end-to-end: which errors get the
 * bespoke surface at all, and — the step-up leg (resource-authorization epic
 * child ⑤) — that "Request access" navigates to device login carrying *exactly*
 * the scopes the 403 named plus where the denial happened, so the screen there
 * can pre-fill the request and the return trip re-runs the denied action.
 *
 * Driven through a real router rather than a mocked `useNavigate`: the assertion
 * is about the resulting location (path + both search params), which a stubbed
 * navigate would delete.
 */

afterEach(() => {
  cleanup()
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

/**
 * Mount whatever `renderScopeError` produced for `error` at {@link DENIED_PATH},
 * inside a router that also carries the real device-login path so the step-up
 * navigation resolves to a live route instead of a 404. Returns the router so
 * assertions can read the location the click produced.
 */
const renderErrorAt = (error: unknown): AnyRouter => {
  const rootRoute = createRootRoute({ component: (): JSX.Element => <Outlet /> })
  const deniedRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: DENIED_PATH,
    component: (): ReactNode => renderScopeError(error),
  })
  const deviceLoginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: DEVICE_LOGIN_ROUTE,
    component: (): JSX.Element => <div>device login</div>,
    validateSearch: (search: Record<string, unknown>): Record<string, unknown> => search,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([deniedRoute, deviceLoginRoute]),
    history: createMemoryHistory({ initialEntries: [DENIED_PATH] }),
  })
  render(<RouterProvider router={router} />)
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
  test('carries the missing scopes and the denial location to device login', async () => {
    const router = renderErrorAt(
      insufficientScopeBody(['wildflower/Grant.d', 'wildflower/Grant.r'])
    )

    await userEvent.click(await screen.findByRole('button', { name: /request access/i }))

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(DEVICE_LOGIN_ROUTE)
    })
    // Read the params back off the rendered `href` with the very decoder the
    // device-login screen uses, so this asserts the encoding the screen will
    // actually see — not a hand-rolled reading of the router's search object.
    const { returnTo, requestScopes } = parseDeviceLoginSearch(
      router.state.location.href.split('?')[1] ?? ''
    )
    // `returnTo` is where the denial happened, so the post-grant full page load
    // re-runs the denied loader; `requestScopes` is exactly what the 403 named.
    expect(returnTo).toBe(DENIED_PATH)
    expect(parseRequestScopes(requestScopes)).toEqual(['wildflower/Grant.d', 'wildflower/Grant.r'])
  })

  test('is not offered when the 403 named no scopes', async () => {
    // The undeclared-403 path: with nothing to pre-fill, a "Request access"
    // button would be indistinguishable from a plain sign-in, so the surface
    // stays a read-only explanation.
    renderErrorAt(undeclaredForbidden())
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /request access/i })).toBeNull()
  })
})
