/**
 * The query parameter `apps/github-pages/404.html` carries an unresolved
 * deep-link route in.
 *
 * @remarks
 * `/medications-app/anything?iss=…` lands on
 * `/medications-app/?redirect=/anything&iss=…` instead of an error page.
 * Completing that redirect is the app's half of the contract
 * ({@link restoreRedirectedUrl}); both halves are described under "The 404
 * redirect" in `slices/branding/AGENTS.md`.
 */
const REDIRECT_PARAM = 'redirect'

/** The part of `window.location` the restoration reads. */
interface RestorableLocation {
  /** The path the redirect landed on — an app root, so its directory is the basename. */
  readonly pathname: string
  /** The query string, carrying {@link REDIRECT_PARAM} plus whatever rode along. */
  readonly search: string
  /** The fragment, passed through untouched. */
  readonly hash: string
}

/** The part of `window.history` the restoration writes through. */
interface RestorableHistory {
  /** Same shape as the DOM's, so `window.history` satisfies it structurally. */
  readonly replaceState: (data: unknown, unused: string, url: string) => void
}

/** What {@link restoreRedirectedUrl} needs: `window`, or a test double of it. */
interface RestorationTarget {
  readonly location: RestorableLocation
  readonly history: RestorableHistory
}

/**
 * The directory `pathname` sits in — the app's basename, always slash-suffixed.
 *
 * @param pathname - A root-relative path, with or without a trailing slash
 * @returns `/medications-app/` for both `/medications-app/` and
 *   `/medications-app/index.html`; `/` for a path with no slash at all
 */
const basenameOf = (pathname: string): string => {
  const lastSlash = pathname.lastIndexOf('/')
  return lastSlash === -1 ? '/' : pathname.slice(0, lastSlash + 1)
}

/**
 * The route the 404 page carried, as a path relative to the app's basename.
 *
 * @param redirected - The {@link REDIRECT_PARAM} value, site-absolute or already
 *   app-relative
 * @param basename - The app's directory, slash-suffixed
 * @returns The route with any leading copy of the basename and any leading
 *   slashes removed — so joining it back onto the basename can never escape the
 *   app's own directory
 */
const appRelativeRoute = (redirected: string, basename: string): string => {
  if (redirected.startsWith(basename)) return redirected.slice(basename.length).replace(/^\/+/, '')
  // The basename with its trailing slash dropped means "the app root" — there
  // is no route left once the basename is off it.
  if (`${redirected}/` === basename) return ''
  return redirected.replace(/^\/+/, '')
}

/**
 * The URL a 404-redirected load should have had, or `undefined` when this load
 * is not a redirect.
 *
 * @param location - The location the browser actually landed on
 * @returns A root-relative URL under the app's basename, with
 *   {@link REDIRECT_PARAM} removed and every other parameter and the fragment
 *   preserved — or `undefined` when there is no redirect to complete
 *
 * @remarks
 * Pure, so the whole contract is unit-testable without a DOM.
 *
 * @example
 * ```ts
 * restoredUrl({ pathname: '/web-trace-app/', search: '?redirect=/trace&iss=x', hash: '#t' })
 * // → '/web-trace-app/trace?iss=x#t'
 * ```
 */
const restoredUrl = (location: RestorableLocation): string | undefined => {
  const parameters = new URLSearchParams(location.search)
  const redirected = parameters.get(REDIRECT_PARAM)
  if (redirected === null || redirected === '') return undefined

  parameters.delete(REDIRECT_PARAM)
  const basename = basenameOf(location.pathname)
  const route = appRelativeRoute(redirected, basename)

  const remaining = parameters.toString()
  return `${basename}${route}${remaining === '' ? '' : `?${remaining}`}${location.hash}`
}

/**
 * The URL that sends a deep link to its app's root, carrying the route in
 * {@link REDIRECT_PARAM} — the redirect `apps/github-pages/404.html` performs,
 * for a server that already knows the app's `basename` (a dev server). The
 * inverse of {@link restoredUrl}.
 *
 * @param location - The deep link the browser asked for
 * @param basename - The app's directory, slash-suffixed
 * @returns `basename` with the deep link's full path set as
 *   {@link REDIRECT_PARAM} and every other parameter and the fragment
 *   preserved — or `undefined` when `location` is the app root itself or lies
 *   outside `basename`
 *
 * @remarks
 * The path goes over site-absolute, not app-relative as `404.html` sends it.
 * {@link restoredUrl} accepts both, but an app-relative route named like the
 * app's own directory (`/app` below `/app/`) is indistinguishable from the
 * basename without its trailing slash, and restores to the app root.
 *
 * @example
 * ```ts
 * redirectedUrl({ pathname: '/app/gatekeeper/devices', search: '?server=x', hash: '' }, '/app/')
 * // → '/app/?server=x&redirect=%2Fapp%2Fgatekeeper%2Fdevices'
 * ```
 */
const redirectedUrl = (location: RestorableLocation, basename: string): string | undefined => {
  if (!location.pathname.startsWith(basename)) return undefined
  if (location.pathname === basename) return undefined
  const parameters = new URLSearchParams(location.search)
  parameters.set(REDIRECT_PARAM, location.pathname)
  return `${basename}?${parameters.toString()}${location.hash}`
}

/**
 * Complete a 404 redirect in the address bar, before anything reads the URL.
 *
 * @param target - `window`, or a double carrying just `location` and `history`
 * @returns The URL that was restored, or `undefined` when this load carried no
 *   {@link REDIRECT_PARAM} and nothing was touched
 *
 * @remarks
 * `history.replaceState` only — no navigation, so the already-loaded bundle
 * keeps running and no entry is added to the session history. Call it at the
 * top of an app's entry module, ahead of the router, the SMART callback check,
 * or anything else that reads `window.location`.
 *
 * @example
 * ```ts
 * restoreRedirectedUrl(window)
 * createRoot(container).render(<AppRoot />)
 * ```
 */
const restoreRedirectedUrl = (target: RestorationTarget): string | undefined => {
  const url = restoredUrl(target.location)
  if (url !== undefined) target.history.replaceState(null, '', url)
  return url
}

export { REDIRECT_PARAM, basenameOf, redirectedUrl, restoreRedirectedUrl, restoredUrl }
export type { RestorableHistory, RestorableLocation, RestorationTarget }
