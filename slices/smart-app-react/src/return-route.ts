import { redirect } from '@tanstack/react-router'
import { appRootRedirectUri, SMART_LAUNCH_PARAMS } from '@wildflowerhealthio/fhir-r4-react/smart'
import { Option } from 'effect'

/**
 * The `sessionStorage` key the route a launch started on waits at, for the
 * app root to return to once the launch completes.
 */
const RETURN_ROUTE_STORAGE_KEY = 'wildflower.smart-launch-return-route'

/**
 * The route a launch page at `launchPageHref` sits on, as a path of the
 * app's router (relative to `servedDirectory`, as `appRootRedirectUri` takes
 * it) with its query, less `SMART_LAUNCH_PARAMS`, and fragment; `None` at the
 * app root, which is where the launch returns anyway.
 */
const returnRouteOf = (launchPageHref: string, servedDirectory?: string): Option.Option<string> => {
  const page = new URL(launchPageHref)
  for (const param of SMART_LAUNCH_PARAMS) page.searchParams.delete(param)
  const appRoot = new URL(appRootRedirectUri(launchPageHref, servedDirectory)).pathname
  const path = `/${page.pathname.slice(appRoot.length)}`
  return path === '/' ? Option.none() : Option.some(`${path}${page.search}${page.hash}`)
}

/**
 * Save the route the launch page at `launchPageHref` sits on, for the app
 * root to return to once the launch completes ({@link appRootRedirect}); a
 * launch at the bare app root clears whatever an earlier launch saved.
 */
const saveReturnRoute = (
  storage: Storage,
  launchPageHref: string,
  servedDirectory?: string
): void => {
  Option.match(returnRouteOf(launchPageHref, servedDirectory), {
    onNone: () => {
      storage.removeItem(RETURN_ROUTE_STORAGE_KEY)
    },
    onSome: (route) => {
      storage.setItem(RETURN_ROUTE_STORAGE_KEY, route)
    },
  })
}

/** Clear a saved return route: a plain visit completes no launch. */
const clearReturnRoute = (storage: Storage): void => {
  storage.removeItem(RETURN_ROUTE_STORAGE_KEY)
}

/** An origin no saved route can name, to parse one against. */
const ROUTE_BASE = 'https://app.invalid'

/**
 * The saved return route, left in place, or `None` when there is none, it
 * is not a path on the page's own origin (`//host`, a full URL), or it is the
 * app root, which would redirect to itself.
 */
const readReturnRoute = (storage: Storage): Option.Option<string> =>
  Option.fromNullable(storage.getItem(RETURN_ROUTE_STORAGE_KEY)).pipe(
    Option.flatMap((saved) => Option.fromNullable(URL.parse(saved, ROUTE_BASE))),
    Option.filter((route) => route.origin === ROUTE_BASE && route.pathname !== '/'),
    Option.map((route) => `${route.pathname}${route.search}${route.hash}`)
  )

/**
 * The redirect a routed app's `/` throws from its `beforeLoad`, replacing
 * itself in history: to the route the launch started on, when one is saved,
 * else to `startRoute` (e.g. `launchStartRoute`'s). Both are paths of the
 * app's router; the router adds its basepath.
 */
const appRootRedirect = (startRoute: string): ReturnType<typeof redirect> =>
  redirect({
    href: Option.getOrElse(readReturnRoute(window.sessionStorage), () => startRoute),
    replace: true,
  })

export {
  appRootRedirect,
  clearReturnRoute,
  readReturnRoute,
  RETURN_ROUTE_STORAGE_KEY,
  saveReturnRoute,
}
