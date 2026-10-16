import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { index, physical, rootRoute, route } from '@tanstack/virtual-file-routes'

/**
 * Virtual route config for host-app. The app owns the skeleton as files under
 * `src/routes`: the root (the Servers | Recorder bar over every route, and the
 * not-found page under it), `/`, which opens `/servers`, and `/recorder`. The
 * base's screens are `servers-react`'s: `physical()` pulls its
 * `routes/servers/` in under `/servers` (the page shell over the server list,
 * Add server and a server's page), and `route()` its `routes/settings.tsx` as
 * `/settings`.
 *
 * Each of the base's routes sits at the path it has under the base's own
 * root, so the id this generator computes for it (`/servers/new`,
 * `/settings`) is the id the base's generator does; otherwise the two would
 * fight over the `createFileRoute('<id>')` literal in each route file.
 *
 * Paths passed to `physical()` and `route()` resolve against
 * `routesDirectory` (`src/routes`), so `../../..` is `apps/host/`.
 */
const routes = rootRoute('__root.tsx', [
  index('index.tsx'),
  physical('/servers', '../../../servers/servers-react/src/routes/servers'),
  route('/settings', '../../../servers/servers-react/src/routes/settings.tsx'),
  route('/recorder', 'recorder.tsx'),
])

/**
 * The route generator over {@link routes}, writing `src/routeTree.gen.ts`.
 * Both `vite.config.ts` (the webview bundle) and `vitest.config.ts` (the tests)
 * run it, before `react()`, so the tree is in place before the React
 * transform.
 */
const hostRoutesPlugin = (): ReturnType<typeof tanstackRouter> =>
  tanstackRouter({
    target: 'react',
    routesDirectory: './src/routes',
    generatedRouteTree: './src/routeTree.gen.ts',
    virtualRouteConfig: routes,
    autoCodeSplitting: false,
    // Colocated `*.test.tsx` files live beside the route modules they
    // exercise; without this the generator would treat them as routes.
    routeFileIgnorePattern: '\\.(test|spec)\\.',
  })

export { hostRoutesPlugin, routes }
