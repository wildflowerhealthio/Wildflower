import type { RouterContext } from '../router-context.ts'
import { TokenTimeoutRetry } from './token-timeout-retry.tsx'

/**
 * Shared `beforeLoad` + `errorComponent` pair for top-level routes that
 * need the bearer-token gate. Routes spread this into their
 * `createFileRoute(...)` options so the gate and its matching
 * retry-screen `errorComponent` stay paired — adding a future
 * auth-gated sibling can't silently drop the `errorComponent` half.
 */
const authGatedRouteOptions = {
  beforeLoad: ({
    context,
    location,
  }: {
    readonly context: RouterContext
    readonly location: { readonly href: string }
  }): Promise<void> => context.awaitAuthReady(location.href),
  errorComponent: TokenTimeoutRetry,
} as const

export { authGatedRouteOptions }
