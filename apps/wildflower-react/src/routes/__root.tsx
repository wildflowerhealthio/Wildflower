import { createRootRoute } from '@tanstack/react-router'

import { RootShell } from '../session/root-shell.tsx'

/**
 * App root. Hosts the full provider stack (via `RootShell`) and renders
 * the matched child route through its `<Outlet />`. Every slice's route
 * directory is mounted beneath this root by the virtual-route config in
 * `vite.config.base.ts`.
 */
export const Route = createRootRoute({ component: RootShell })
