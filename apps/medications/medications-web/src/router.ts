import { createRouter, type Router, type RouterHistory } from '@tanstack/react-router'

import type { RouterContext } from './router-context.ts'
import { routeTree } from './routeTree.gen.ts'

/** The app's router. */
type MedicationsRouter = Router<typeof routeTree, 'never', false>

/**
 * The page's query as flat strings, every value as the address bar holds it.
 *
 * @remarks
 * The router's default reads `?patient=123` as the number `123` and writes
 * the string `'123'` back as `?patient=%22123%22`. The app's only query is
 * `?patient=`, a FHIR id or `*` in `smart-app-react`'s plain form, so it is
 * read and written with `URLSearchParams` as it stands.
 */
const parseSearch = (searchStr: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(searchStr))

/** The inverse of {@link parseSearch}: every string value, leaving out unset keys. */
const stringifySearch = (search: Record<string, unknown>): string => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string') params.set(key, value)
  }
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

/**
 * The app's router, at `basepath` (the served directory: one build serves its
 * origin's root and a PR preview's `/pr-<n>/`) over `history`, giving every
 * route `context`.
 */
const buildRouter = (options: {
  readonly history: RouterHistory
  readonly basepath: string
  readonly context: RouterContext
}): MedicationsRouter =>
  createRouter({
    routeTree,
    history: options.history,
    basepath: options.basepath,
    context: options.context,
    parseSearch,
    stringifySearch,
  })

// The app's is the only router on the page, so registering it types every
// `<Link to>` and `navigate` against its routes.
declare module '@tanstack/react-router' {
  interface Register {
    router: MedicationsRouter
  }
}

export { buildRouter }
