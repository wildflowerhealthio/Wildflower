import { createRootRouteWithContext } from '@tanstack/react-router'

import type { RouterContext } from '../bridges/router-context.ts'
import { RootShell } from '../session/root-shell.tsx'

/**
 * App root. Hosts the full provider stack (via `RootShell`) and renders
 * the matched child route through its `<Outlet />`. Every slice's route
 * directory is mounted beneath this root by the virtual-route config in
 * `vite.config.base.ts`.
 *
 * Typed via `createRootRouteWithContext<RouterContext>()` so every route
 * `loader` / `beforeLoad` receives the {@link RouterContext} — the shared
 * in-memory `queryClient` (for `ensureQueryData` prefetch) and the
 * `runAuthed` runner (for authenticated slice effects). The concrete
 * context value is supplied to `createRouter({ context })` in
 * `app-root.tsx`.
 */
export const Route = createRootRouteWithContext<RouterContext>()({ component: RootShell })
