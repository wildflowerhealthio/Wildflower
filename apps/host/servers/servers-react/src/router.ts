import { createRouter, type Router, type RouterHistory } from '@tanstack/react-router'

import type { RouterContext } from './router-context.ts'
import { routeTree } from './routeTree.gen.ts'

/** The base's router over its screens, read from `routes/`. */
type BaseRouter = Router<typeof routeTree, 'never', false>

/** The base's router over `history`, giving every route `context`. */
const buildBaseRouter = ({
  history,
  context,
}: {
  readonly history: RouterHistory
  readonly context: RouterContext
}): BaseRouter => createRouter({ routeTree, history, context })

// The base is the only router in the Tauri host's webview, so registering it
// types every `<Link to>` against the base's own routes.
declare module '@tanstack/react-router' {
  interface Register {
    router: BaseRouter
  }
}

export { buildBaseRouter }
