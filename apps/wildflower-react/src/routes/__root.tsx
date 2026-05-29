import { createRootRouteWithContext } from '@tanstack/react-router'

import type { RouterContext } from '../router-context.ts'
import { RootShell } from '../session/root-shell.tsx'

/**
 * App root. Hosts the slice client providers (`RootShell`) and renders
 * the matched child via `<Outlet />`. Slice route directories are
 * mounted beneath via virtual-route config in `vite.config.base.ts`.
 */
export const Route = createRootRouteWithContext<RouterContext>()({ component: RootShell })
