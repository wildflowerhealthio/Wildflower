import { index, layout, physical, rootRoute, route } from '@tanstack/virtual-file-routes'

/**
 * Virtual route config for wildflower-react. The app owns the structural
 * skeleton (root provider stack, the `_auth` gate, the `/settings`
 * layout) as physical files under `src/routes`, and pulls each slice's
 * route directory into the tree with `physical()`.
 *
 * The three slice buckets mount as SIBLINGS so that the id a slice's own
 * generator computes (from its top-level folder) is identical to the id
 * this app generator computes — otherwise the two generators fight over
 * the single `createFileRoute('<id>')` literal in each route file.
 *
 *   - `settings/` → mounted under the real `/settings` route → `/settings/…`
 *   - `_auth/`    → mounted under the pathless `_auth` layout  → `/_auth/…`
 *   - `_open/`    → mounted under the pathless `_open` layout  → `/_open/…`
 *
 * Section sub-layouts (`_auth/home.tsx`, `_auth/gatekeeper.tsx`,
 * `_open/gatekeeper.tsx`) live in the app's own `src/routes` directory.
 * Each wraps its slice mount in the shared `pageLayoutStyles['page']`
 * shell so the leaves render content only. They cannot live in their
 * source slice because `physical()` mounts compute the generated
 * route-variable name from the in-mount path: with a slice-level
 * `_auth/gatekeeper.tsx` AND `_open/gatekeeper.tsx`, both reduce to
 * `Gatekeeper` and the wildflower-react `routeTree.gen.ts` ends up with a
 * duplicate `const GatekeeperRoute = …`. Owning the section layout at the
 * app level keeps the `/_auth/` / `/_open/` prefix in scope for the
 * generator so it disambiguates as `AuthGatekeeperRoute` /
 * `OpenGatekeeperRoute`.
 *
 * Because `/settings` is a sibling of `_auth` (not a child), it is not
 * auth-gated by the `_auth` layout's `beforeLoad`. The `/settings`
 * route re-applies the same gate via the shared
 * `authGatedRouteOptions`, so the runtime behavior (settings requires
 * auth) is preserved.
 *
 * Paths passed to `physical()` are resolved relative to
 * `routesDirectory` (`src/routes`), so `../../../../slices` reaches the
 * monorepo's `slices/` directory.
 */
const slices = '../../../../slices'

const routesDir = (slice: string, bucket: string): string =>
  `${slices}/${slice}/${slice}-react/src/routes/${bucket}`

export const routes = rootRoute('__root.tsx', [
  route('/settings', 'settings.tsx', [
    index('settings/index.tsx'),
    physical('', routesDir('tunnel', 'settings')),
    physical('', routesDir('gatekeeper', 'settings')),
    physical('', routesDir('databases', 'settings')),
    physical('', routesDir('apps', 'settings')),
  ]),
  layout('_auth', '_auth.tsx', [
    index('_auth/index.tsx'),
    physical('', routesDir('collector', '_auth')),
    physical('', routesDir('har-recorder', '_auth')),
    route('/home', '_auth/home.tsx', [physical('', routesDir('apps', '_auth/home'))]),
    route('/gatekeeper', '_auth/gatekeeper.tsx', [
      physical('', routesDir('gatekeeper', '_auth/gatekeeper')),
    ]),
  ]),
  layout('_open', '_open.tsx', [
    route('/gatekeeper', '_open/gatekeeper.tsx', [
      physical('', routesDir('gatekeeper', '_open/gatekeeper')),
    ]),
  ]),
])
