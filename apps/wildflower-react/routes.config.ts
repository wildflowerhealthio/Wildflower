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
  ]),
  layout('_auth', '_auth.tsx', [
    index('_auth/index.tsx'),
    physical('', routesDir('collector', '_auth')),
    physical('', routesDir('apps', '_auth')),
    physical('', routesDir('gatekeeper', '_auth')),
  ]),
  layout('_open', '_open.tsx', [physical('', routesDir('gatekeeper', '_open'))]),
])
