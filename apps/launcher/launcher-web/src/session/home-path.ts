import { ServerKind } from './server-kind.ts'

/**
 * Where a session on a {@link ServerKind} lands: `/home`, the apps home, on a
 * Wildflower server; `/fhir-home` on a plain SMART server, since every other
 * surface calls Wildflower-only endpoints and `/home`'s apps list is the
 * Wildflower server's.
 *
 * A literal union, kept by hand: the route-tree-derived alternatives don't pay
 * off here — `LinkProps['to']` widens to `any` (an unsafe assignment at a
 * `redirect({ to })` call site) and `RoutePaths` isn't re-exported from
 * `@tanstack/react-router`.
 */
type HomePath = '/home' | '/fhir-home'

/** The home for `serverKind`: where the route guards send a session that reached the other kind's routes. */
const homePathFor = (serverKind: ServerKind): HomePath =>
  ServerKind.$match(serverKind, {
    Wildflower: (): HomePath => '/home',
    PlainSmart: (): HomePath => '/fhir-home',
  })

export { homePathFor }
export type { HomePath }
