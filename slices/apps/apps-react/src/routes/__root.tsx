import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'

/**
 * Context the apps slice's routes assume is threaded through the router.
 * Mirrors (structurally) the app shell's `RouterContext`
 * (`apps/wildflower-react/src/bridges/router-context.ts`): a single
 * `QueryClient`. Declaring it here — rather than importing the app's type
 * (a slice must not depend on an app) — lets the slice's `loader`s read a
 * fully-typed `context.queryClient` when the tree type-checks in
 * isolation, and stays structurally compatible with the app's context
 * when the routes are mounted beneath the app's own root.
 */
interface AppsRouterContext {
  readonly queryClient: QueryClient
}

/**
 * Standalone root for the apps slice's own file-based route tree. The
 * generator needs a `__root` to anchor `routeTree.gen.ts` so the slice
 * type-checks in isolation. In `apps/wildflower-react` the slice's
 * `_auth/` directory is mounted under the app's own `_auth` layout via
 * `@tanstack/virtual-file-routes`, so this root is never used there — but
 * typing it with {@link AppsRouterContext} is what gives the slice's
 * route `loader`s a typed `context.queryClient` for
 * `context.queryClient.ensureQueryData(...)` prefetches.
 */
export const Route = createRootRouteWithContext<AppsRouterContext>()({ component: Outlet })

export type { AppsRouterContext }
