import type { RouterHistory } from '@tanstack/react-router'
import { appRootRedirectUri, LAUNCH_ERROR_PARAM } from '@wildflowerhealthio/fhir-r4-react/smart'

/**
 * The `sessionStorage` key the route a launch landed on waits at while the
 * page is away at the authorization server.
 */
const LANDING_ROUTE_STORAGE_KEY = 'wildflower.smart-launch-landing-route'

/**
 * The query parameters that belong to the launch or its OAuth round trip,
 * not to the route: what fhirclient reads off a launch URL and the
 * callback's. The app root's own `?launchError` (`LAUNCH_ERROR_PARAM`) is
 * one too.
 */
const LAUNCH_PARAMS = [
  'iss',
  'launch',
  'fhirServiceUrl',
  'patientId',
  'clientId',
  'code',
  'state',
  'error',
  'error_description',
  'error_uri',
] as const

/**
 * The route a launch page at `launchPageHref` sits on, as an absolute path
 * with its query (less {@link LAUNCH_PARAMS} and `LAUNCH_ERROR_PARAM`) and
 * fragment, or `null` when that is the app root (`appDirectory`, as
 * `appRootRedirectUri` takes it) with nothing else.
 */
const landingRouteOf = (launchPageHref: string, appDirectory?: string): string | null => {
  const page = new URL(launchPageHref)
  for (const param of [...LAUNCH_PARAMS, LAUNCH_ERROR_PARAM]) page.searchParams.delete(param)
  const route = `${page.pathname}${page.search}${page.hash}`
  return route === new URL(appRootRedirectUri(launchPageHref, appDirectory)).pathname ? null : route
}

/**
 * Keep the route the launch page at `launchPageHref` sits on, for the
 * callback to restore ({@link restoreLandingRoute}); a launch at the bare app
 * root (`appDirectory`) clears whatever an earlier launch left.
 */
const saveLandingRoute = (
  storage: Storage,
  launchPageHref: string,
  appDirectory?: string
): void => {
  const route = landingRouteOf(launchPageHref, appDirectory)
  if (route === null) storage.removeItem(LANDING_ROUTE_STORAGE_KEY)
  else storage.setItem(LANDING_ROUTE_STORAGE_KEY, route)
}

/** Drop a kept landing route, on a launch that did not complete. */
const forgetLandingRoute = (storage: Storage): void => {
  storage.removeItem(LANDING_ROUTE_STORAGE_KEY)
}

/**
 * Take the kept landing route out of `storage` and, when it is a path under
 * `basepath` on this origin, replace `history`'s current entry with it.
 *
 * @remarks
 * One-shot: the key is removed whether or not the route is used. Anything
 * that does not parse as a same-origin path under the served directory (a
 * protocol-relative `//host`, a full URL, another app's directory) is
 * ignored, so the key can never redirect the page off the app.
 */
const restoreLandingRoute = (
  storage: Storage,
  page: { readonly history: RouterHistory; readonly basepath: string }
): void => {
  const saved = storage.getItem(LANDING_ROUTE_STORAGE_KEY)
  storage.removeItem(LANDING_ROUTE_STORAGE_KEY)
  if (saved === null || !saved.startsWith('/')) return
  const origin = window.location.origin
  const route = URL.parse(saved, origin)
  if (route === null || route.origin !== origin || !route.pathname.startsWith(page.basepath)) {
    return
  }
  page.history.replace(`${route.pathname}${route.search}${route.hash}`)
}

/**
 * Replace `history`'s current entry with the app's route `route` (a path of
 * its router's, such as `/patients/p1`, under `basepath`), while the page
 * sits on the bare app root, where a callback leaves it.
 *
 * @remarks
 * Anywhere else it leaves the page alone: on a deep landing route just
 * restored, and on StrictMode's second render, which finds the entry the
 * first one set.
 */
const landOnRoute = (
  page: { readonly history: RouterHistory; readonly basepath: string },
  route: string
): void => {
  if (page.history.location.pathname !== page.basepath) return
  page.history.replace(`${page.basepath}${route.replace(/^\//, '')}`)
}

export {
  forgetLandingRoute,
  LANDING_ROUTE_STORAGE_KEY,
  landOnRoute,
  restoreLandingRoute,
  saveLandingRoute,
}
