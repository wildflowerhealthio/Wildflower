import { createRootRouteWithContext, retainSearchParams } from '@tanstack/react-router'

import type { RouterContext } from '../router-context.ts'
import { RootShell } from '../session/root-shell.tsx'

/**
 * The search every route carries: `server`, the API server `main-web` points
 * at (`web-entry.ts` reads it at boot). Absent for `main-tauri`.
 */
interface RootSearch {
  readonly server?: string
}

/** Keep a string `server`, drop anything else this route doesn't own. */
const validateRootSearch = (search: Record<string, unknown>): RootSearch => {
  const server = search['server']
  return typeof server === 'string' ? { server } : {}
}

/**
 * App root. Hosts the slice client providers (`RootShell`) and renders
 * the matched child via `<Outlet />`. Slice route directories are
 * mounted beneath via virtual-route config in `vite.config.base.ts`.
 *
 * `?server=` is retained across every navigation while it is in the URL, so
 * a reader who has picked a server but not yet signed in keeps it through the
 * auth gate's bounce back to the landing. After sign-in `main-web` settles on
 * a URL without it (see `postSignInUrl`), and from then on there is nothing to
 * retain: the address bar and the links the router builds name no server. The
 * tab remembers it in `sessionStorage` instead, so a reload signs back in to
 * the same server (see `web-entry.ts`'s `chosenServerUrl`).
 */
/** The root's search handling, shared with its test. */
const rootSearchOptions = {
  validateSearch: validateRootSearch,
  search: { middlewares: [retainSearchParams<RootSearch>(['server'])] },
}

const Route = createRootRouteWithContext<RouterContext>()({
  ...rootSearchOptions,
  component: RootShell,
})

export { Route, rootSearchOptions }
