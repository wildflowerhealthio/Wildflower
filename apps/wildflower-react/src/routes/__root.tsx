import { createRootRouteWithContext } from '@tanstack/react-router'

import type { RouterContext } from '../bridges/router-context.ts'
import { RootShell } from '../session/root-shell.tsx'

/**
 * App root. Hosts the full provider stack (via `RootShell`) and renders
 * the matched child route through its `<Outlet />`. Every slice's route
 * directory is mounted beneath this root by the virtual-route config in
 * `vite.config.base.ts`.
 *
 * Built with `createRootRouteWithContext<RouterContext>()` so the
 * shared {@link RouterContext} (carrying the app's single `QueryClient`)
 * is typed all the way down: child-route `loader`s receive a fully-typed
 * `context.queryClient`. The concrete context value is supplied to
 * `createRouter` in `app-root.tsx`.
 */
export const Route = createRootRouteWithContext<RouterContext>()({ component: RootShell })
