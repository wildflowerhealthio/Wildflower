import { redirect } from '@tanstack/react-router'

import type { RouterContext } from '../router-context.ts'
import { AuthGatedErrorComponent } from './auth-gated-error.tsx'
import type { ServerKind } from './server-kind.ts'
import { homeTabFor } from './tabs.ts'

/**
 * Shared `beforeLoad` + `errorComponent` pair for top-level routes that
 * need the bearer-token gate and serve one {@link ServerKind}. Routes spread
 * one of the two below into their `createFileRoute(...)` options so the gate
 * and its matching retry-screen `errorComponent` stay paired — adding a
 * future auth-gated sibling can't silently drop the `errorComponent` half.
 *
 * Past the gate, a route for the other kind of server redirects to that
 * kind's Home (`homeTabFor`): the Wildflower routes call endpoints a plain
 * SMART server doesn't have, and the plain SMART Home says the server is not
 * a Wildflower one. The redirect is in `beforeLoad`, so the route's loader
 * never runs for the other kind.
 *
 * `errorComponent` is `AuthGatedErrorComponent`, which wraps the body-only
 * `TokenTimeoutRetry` in the shared `.page` shell so the failure surface
 * gets the same layout every other route does. The wrap lives in a
 * separate `.tsx` file so this options module stays JSX-free and the
 * React Fast-Refresh `only-export-components` rule has no qualm.
 */
const authGatedRouteOptionsFor = (servedKind: ServerKind['_tag']) =>
  ({
    beforeLoad: async ({
      context,
      location,
    }: {
      readonly context: RouterContext
      readonly location: { readonly href: string }
    }): Promise<void> => {
      await context.awaitAuthReady(location.href)
      if (context.serverKind._tag !== servedKind) {
        throw redirect({ to: homeTabFor(context.serverKind).path })
      }
    },
    errorComponent: AuthGatedErrorComponent,
  }) as const

/** The gate for the routes only a Wildflower server serves: `_auth` and `/settings`. */
const wildflowerRouteOptions = authGatedRouteOptionsFor('Wildflower')

/** The gate for the plain SMART server's Home, `/fhir-home`. */
const plainSmartRouteOptions = authGatedRouteOptionsFor('PlainSmart')

export { plainSmartRouteOptions, wildflowerRouteOptions }
