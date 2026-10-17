import { createRouter, type Router } from '@tanstack/react-router'
import {
  parsePlainSearch,
  type SmartAppPage,
  stringifyPlainSearch,
} from '@wildflowerhealthio/smart-app-react'

import type { RouterContext } from './router-context.ts'
import { routeTree } from './routeTree.gen.ts'

/** The app's router. */
type MedicationsRouter = Router<typeof routeTree, 'never', false>

/**
 * The app's router over `page` (its history, under the served directory: one
 * build serves its origin's root and a PR preview's `/pr-<n>/`), giving every
 * route `context`, its query read and written as flat strings
 * (`smart-app-react`'s `parsePlainSearch`), so `?patient=` holds an id as the
 * address bar does.
 */
const buildRouter = (
  { history, basepath }: SmartAppPage,
  context: RouterContext
): MedicationsRouter =>
  createRouter({
    routeTree,
    history,
    basepath,
    context,
    parseSearch: parsePlainSearch,
    stringifySearch: stringifyPlainSearch,
  })

// The app's is the only router on the page, so registering it types every
// `<Link to>` and `navigate` against its routes.
declare module '@tanstack/react-router' {
  interface Register {
    router: MedicationsRouter
  }
}

export { buildRouter }
