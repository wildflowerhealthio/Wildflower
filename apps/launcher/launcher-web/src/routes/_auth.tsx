import { createFileRoute, Outlet } from '@tanstack/react-router'
import { appsListQueryOptions } from '@wildflowerhealthio/apps-react'

import type { RouterContext } from '../router-context.ts'
import { wildflowerRouteOptions } from '../session/auth-gated-route-options.ts'

/**
 * Pathless `_auth` layout. Gates owner-facing routes on a live bearer
 * token via a `beforeLoad` that `await`s the injected
 * `context.awaitAuthReady()` — with no token it bubbles a TanStack
 * `redirect` to the landing page. Every route under it calls
 * Wildflower-only endpoints, so the same `beforeLoad` then redirects a
 * session on a plain SMART server to its own Home, `/fhir-home`
 * (`wildflowerRouteOptions`). Once the gate passes the matched child route
 * renders through `<Outlet>`, with its authed loaders guaranteed a token and
 * a Wildflower server.
 *
 * The route's `loader` runs once per gate-pass and warms the key startup
 * query (the apps list) so the main destination renders without a network
 * spinner. It is best-effort: `Promise.allSettled` keeps a prefetch failure
 * from failing the route, whose own loaders report it.
 */
const authLoader = async ({ context }: { readonly context: RouterContext }): Promise<void> => {
  await Promise.allSettled([context.queryClient.query(appsListQueryOptions(context.runAuthed))])
}

export const Route = createFileRoute('/_auth')({
  ...wildflowerRouteOptions,
  loader: authLoader,
  component: Outlet,
})
