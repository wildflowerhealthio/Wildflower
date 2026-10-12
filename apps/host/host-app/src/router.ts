import { createRouter, type Router, type RouterHistory } from '@tanstack/react-router'

import type { RouterContext } from './router-context.ts'
import { routeTree } from './routeTree.gen.ts'

/** The host's router: its own routes and the base's, from `routes.config.ts`. */
type HostRouter = Router<typeof routeTree, 'never', false>

/** The host's router over `history`, giving every route `context`. */
const buildHostRouter = ({
  history,
  context,
}: {
  readonly history: RouterHistory
  readonly context: RouterContext
}): HostRouter => createRouter({ routeTree, history, context })

// The host's is the only router in its webview, so registering it types every
// `<Link to>`, the base's included, against the whole tree.
declare module '@tanstack/react-router' {
  interface Register {
    router: HostRouter
  }
}

export { buildHostRouter }
