import { createRouter, type Router } from '@tanstack/react-router'
import type { SmartAppPage } from '@wildflowerhealthio/smart-app-react'

import type { RouterContext } from './router-context.ts'
import { routeTree } from './routeTree.gen.ts'

/** The app's router. */
type StrengthRouter = Router<typeof routeTree, 'never', false>

/**
 * The app's router over `page` (its history, under the served directory: one
 * build serves its origin's root and a PR preview's `/pr-<n>/`), giving every
 * route `context`. A path no route names goes to the root's no-page card
 * wherever it sits (`notFoundMode: 'root'`), so a patient route's
 * not-found card only ever means the server has no such patient.
 */
const buildRouter = ({ history, basepath }: SmartAppPage, context: RouterContext): StrengthRouter =>
  createRouter({
    routeTree,
    history,
    basepath,
    context,
    notFoundMode: 'root',
  })

// The app's is the only router on the page, so registering it types every
// `<Link to>` and `navigate` against its routes.
declare module '@tanstack/react-router' {
  interface Register {
    router: StrengthRouter
  }
}

export { buildRouter }
