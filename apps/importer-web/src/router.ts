import { createRouter, type Router, type RouterHistory } from '@tanstack/react-router'
import type { FhirR4ResourcesRouterContext } from '@wildflowerhealthio/fhir-r4-react'

import { routeTree } from './routeTree.gen.ts'

/**
 * The router context `importer-react` reads through — this app's instantiation
 * of the shared shape, narrowed to the one slice client it needs.
 */
type RouterContext = FhirR4ResourcesRouterContext.RouterContext

/** The app's router. */
type ImporterRouter = Router<typeof routeTree, 'never', false>

/**
 * The app's router, at `basepath` (the served directory: one build serves its
 * origin's root and a PR preview's `/pr-<n>/`) over `history`, giving every
 * route `context`.
 */
const buildRouter = (options: {
  readonly history: RouterHistory
  readonly basepath: string
  readonly context: RouterContext
}): ImporterRouter =>
  createRouter({
    routeTree,
    history: options.history,
    basepath: options.basepath,
    context: options.context,
  })

declare module '@tanstack/react-router' {
  // The app's is the only router on the page, so registering it types every
  // `<Link to>` and `navigate` against its routes.
  interface Register {
    router: ImporterRouter
  }

  interface StaticDataRouteOption {
    /** The line under the page title naming what a tab's screen does. */
    readonly subtitle?: string
  }
}

export { buildRouter, type RouterContext }
