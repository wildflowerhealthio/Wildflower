import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { layout, physical, rootRoute, route } from '@tanstack/virtual-file-routes'

/**
 * Virtual route config for host-app. The app owns the skeleton as files under
 * `src/routes`: the root (the Servers | Recorder bar over every route, and the
 * not-found page under it), `/recorder`, and the pathless `_servers` layout,
 * into which `physical()` pulls `servers-react`'s `routes/_servers/`, the
 * base's screens.
 *
 * The base's bucket mounts under a layout of the same name, so the id its
 * own generator computes for each route (`/_servers/settings`) is the id this
 * generator computes; otherwise the two would fight over the
 * `createFileRoute('<id>')` literal in each route file.
 *
 * Paths passed to `physical()` resolve against `routesDirectory`
 * (`src/routes`), so `../../..` is `apps/host/`.
 */
const routes = rootRoute('__root.tsx', [
  layout('_servers', '_servers.tsx', [
    physical('', '../../../servers/servers-react/src/routes/_servers'),
  ]),
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
