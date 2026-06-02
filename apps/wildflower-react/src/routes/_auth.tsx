import { createFileRoute, Outlet } from '@tanstack/react-router'
import { appsListQueryOptions } from 'apps-react'
import { remotesQueryOptions } from 'collector-react'
import { Effect } from 'effect'
import type { JSX } from 'react'
import { Sentry } from 'telemetry-web'
import { tunnelStateQueryOptions } from 'tunnel-react'

import type { RouterContext } from '../router-context.ts'
import { authGatedRouteOptions } from '../session/auth-gated-route-options.ts'

/**
 * Pathless `_auth` layout. Gates owner-facing routes on a live bearer
 * token via a `beforeLoad` that `await`s the injected
 * `context.awaitAuthReady()` — standalone web with no token bubbles a
 * TanStack `redirect` into the device-login flow, embedded waits the
 * host handshake (and on timeout renders the `TokenTimeoutRetry`
 * screen). Once the gate passes the matched child route renders
 * through `<Outlet>`, with its authed loaders guaranteed a token.
 *
 * The route's `loader` runs once per gate-pass and:
 *
 *   1. Warms the key startup queries (tunnel state, apps list,
 *      collector remotes list) so every main destination renders
 *      without a network spinner — hiding the web-app nature of these
 *      pages in the embedded WebView.
 *   2. Emits the embedded `UIReady` nav-bridge message so the host
 *      hides its native splash / reveals the WebView. This used to
 *      live in a `<UIReadyEmitter>` component; folding it into the
 *      loader removes a layer of React-effect indirection and ties
 *      the emit to the same "post-gate, pre-render" lifecycle TanStack
 *      already provides via `loader`.
 *
 * Both halves are best-effort: a prefetch failure or a `sendMessage`
 * failure must not block the WebView reveal (otherwise a transient HTTP
 * miss or a torn-down transport would leave the host splash up).
 * `Promise.allSettled` covers the prefetches; the `UIReady` send is
 * wrapped in a `.catch` that reports to Sentry and resolves anyway, so
 * the loader always resolves `void`.
 */
const authLoader = async ({ context }: { readonly context: RouterContext }): Promise<void> => {
  const transport = await context.transport
  await Promise.allSettled([
    context.queryClient.prefetchQuery(tunnelStateQueryOptions(context.runAuthed)),
    context.queryClient.prefetchQuery(appsListQueryOptions(context.runAuthed)),
    context.queryClient.prefetchQuery(remotesQueryOptions(context.runAuthed)),
  ])
  await Effect.runPromise(transport.sendMessage({ _tag: 'UIReady' })).catch((error: unknown) => {
    Sentry.captureException(error, { tags: { source: 'authLoader.UIReady' } })
  })
}

function AuthLayout(): JSX.Element {
  return <Outlet />
}

export const Route = createFileRoute('/_auth')({
  ...authGatedRouteOptions,
  loader: authLoader,
  component: AuthLayout,
})
