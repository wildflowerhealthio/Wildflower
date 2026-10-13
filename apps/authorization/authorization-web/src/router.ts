import { createRouter, type Router, type RouterHistory } from '@tanstack/react-router'

import type { RouterContext } from './router-context.ts'
import { routeTree } from './routes/route-tree.tsx'

/** The signed-in app's router. */
type AuthorizationRouter = Router<typeof routeTree, 'never', false>

/**
 * The signed-in app's router, at `basepath` (the served directory: one build
 * serves `/authorization/` and a PR preview's `/staging/pr-<n>/authorization/`)
 * over `history`, giving every route `context`.
 */
const buildRouter = (options: {
  readonly history: RouterHistory
  readonly basepath: string
  readonly context: RouterContext
}): AuthorizationRouter =>
  createRouter({
    routeTree,
    history: options.history,
    basepath: options.basepath,
    context: options.context,
    defaultPreload: 'intent',
  })

// The app's is the only router on the page, so registering it types every
// `<Link to>` and `navigate` against its routes.
declare module '@tanstack/react-router' {
  interface Register {
    router: AuthorizationRouter
  }
}

export { buildRouter }
