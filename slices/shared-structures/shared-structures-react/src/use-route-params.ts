import type { AnyRoute, ResolveParams } from '@tanstack/react-router'

/**
 * Typed access to a route's path params, reconstructed from the route's
 * own path literal.
 *
 * `route.useParams()` collapses to `any` here: the hook resolves params by
 * looking up the route's id in the *registered* router
 * (`RouteById<RegisteredRouter['routeTree'], TId>`), but this app composes
 * its router from code-based slice factories and never registers one, so
 * `RegisteredRouter` falls back to `AnyRouter`. The param shape is therefore
 * unavailable through the hook — independent of how the parent is typed.
 *
 * `ResolveParams<P>` reconstructs it from the path literal alone (a `$id`
 * segment → `{ id: string }`), with no dependency on the parent chain or on
 * router registration. Pass the same literal used for the route's `path` so
 * the params type and the URL stay coupled to one source of truth. There is
 * no runtime parse — only the `useParams()` value re-typed.
 */
export const useRouteParams = <P extends string>(route: AnyRoute, path: P): ResolveParams<P> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  route.useParams() as ResolveParams<typeof path>
