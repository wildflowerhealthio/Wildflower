import type { RouterContext } from '../router-context.ts'
import { AuthGatedErrorComponent } from './auth-gated-error.tsx'

/**
 * Shared `beforeLoad` + `errorComponent` pair for top-level routes that
 * need the bearer-token gate. Routes spread this into their
 * `createFileRoute(...)` options so the gate and its matching
 * retry-screen `errorComponent` stay paired — adding a future
 * auth-gated sibling can't silently drop the `errorComponent` half.
 *
 * `errorComponent` is `AuthGatedErrorComponent`, which wraps the body-only
 * `TokenTimeoutRetry` in the shared `.page` shell so the failure surface
 * gets the same layout every other route does. The wrap lives in a
 * separate `.tsx` file so this options module stays JSX-free and the
 * React Fast-Refresh `only-export-components` rule has no qualm.
 */
const authGatedRouteOptions = {
  beforeLoad: ({
    context,
    location,
  }: {
    readonly context: RouterContext
    readonly location: { readonly href: string }
  }): Promise<void> => context.awaitAuthReady(location.href),
  errorComponent: AuthGatedErrorComponent,
} as const

export { authGatedRouteOptions }
