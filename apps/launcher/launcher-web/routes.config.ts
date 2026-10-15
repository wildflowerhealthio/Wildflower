import { index, layout, physical, rootRoute, route } from '@tanstack/virtual-file-routes'

/**
 * Virtual route config for launcher-web. The app owns the structural
 * skeleton (root provider stack, the `_auth` gate, the `/settings`
 * layout) as physical files under `src/routes`, and pulls the route
 * directory of each package beside it in `apps/launcher/` into the tree
 * with `physical()`.
 *
 * The buckets mount so that the id a package's own generator computes
 * (from its top-level folder) is identical to the id this app generator
 * computes — otherwise the two generators fight over the single
 * `createFileRoute('<id>')` literal in each route file.
 *
 *   - `settings/`   → mounted under the real `/settings` route → `/settings/…`
 *   - `_auth/home/` → mounted under `_auth/home.tsx`           → `/_auth/home/…`
 *
 * The section sub-layout `_auth/home.tsx` lives in the app's own
 * `src/routes` directory and wraps its package mount in the shared
 * `pageLayoutStyles['page']` shell so the leaves render content only.
 *
 * Because `/settings` is a sibling of `_auth` (not a child), it is not
 * auth-gated by the `_auth` layout's `beforeLoad`. The `/settings`
 * route re-applies the same gate via the shared
 * `wildflowerRouteOptions`, so the runtime behavior (settings requires
 * auth, on a Wildflower server) is preserved.
 *
 * `/fhir-home`, a plain SMART server's Home, is a sibling of `_auth` for
 * the same reason the other way round: everything under `_auth` calls
 * Wildflower-only endpoints, so `_auth` redirects a plain SMART server's
 * session to `/fhir-home`, which gates itself with
 * `plainSmartRouteOptions`.
 *
 * Paths passed to `physical()` are resolved relative to
 * `routesDirectory` (`src/routes`), so `../../..` reaches this app's
 * folder, `apps/launcher/`, where the packages built only for the
 * launcher sit.
 */
const launcher = '../../..'

/** A route bucket of a package beside this app in `apps/launcher/`. */
const launcherRoutesDir = (packageDir: string, bucket: string): string =>
  `${launcher}/${packageDir}/src/routes/${bucket}`

export const routes = rootRoute('__root.tsx', [
  route('/settings', 'settings.tsx', [
    index('settings/index.tsx'),
    physical('', launcherRoutesDir('request-log/request-log-react', 'settings')),
    physical('', launcherRoutesDir('databases/databases-react', 'settings')),
    physical('', launcherRoutesDir('apps-react', 'settings')),
  ]),
  index('index.tsx'),
  route('/fhir-home', 'fhir-home.tsx'),
  layout('_auth', '_auth.tsx', [
    route('/home', '_auth/home.tsx', [physical('', launcherRoutesDir('apps-react', '_auth/home'))]),
  ]),
])
