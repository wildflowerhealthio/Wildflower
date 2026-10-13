import {
  isAuthorizationResponse,
  searchWithoutAuthorizationResponse,
  type SignInPage,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Option } from 'effect'

import type { LandingProps, LandingSignIn } from './landing.tsx'
import { searchWithServerUrl, serverUrlFromSearch } from './server-param.ts'
import {
  finishSignIn,
  inAppReturnPath,
  signInEnvironment,
  startSignIn,
  type ServerSession,
} from './sign-in.ts'

/** The slice of `window` the boot reads and rewrites; a real `Window` satisfies it. */
interface BootPage extends SignInPage {
  readonly location: SignInPage['location'] & Pick<Location, 'pathname' | 'search' | 'assign'>
  readonly history: Pick<History, 'replaceState'>
}

/** What the page shows once booted: the signed-in app, or the landing. */
type Boot =
  | { readonly tag: 'SignedIn'; readonly session: ServerSession }
  | { readonly tag: 'SignedOut'; readonly landing: Omit<LandingProps, 'aboveFooter'> }

/**
 * `route` (an in-app path such as `/approved/abc`) under the served
 * `basepath`, as the address bar needs it.
 *
 * @example underBasepath('/staging/pr-7/authorization/', '/approved/abc') // '/staging/pr-7/authorization/approved/abc'
 */
const underBasepath = (basepath: string, route: string): string =>
  `${basepath.replace(/\/$/, '')}${route}`

/**
 * The in-app route `pathname` names under `basepath`, when it is a route
 * other than the app root: where a reader who opened a deep link before
 * signing in was headed.
 */
const deepRouteOf = (pathname: string, basepath: string): string | undefined => {
  if (!pathname.startsWith(basepath)) return undefined
  const route = `/${pathname.slice(basepath.length)}`
  return route === '/' ? undefined : route
}

/**
 * The browser's {@link LandingSignIn}: a sign-in from the landing returns to
 * the app root under `basepath`, carrying `returnTo` in the pending record.
 */
const browserLandingSignIn = (
  page: BootPage,
  basepath: string,
  returnTo: string | undefined
): LandingSignIn => ({
  start: (serverUrl) => startSignIn(serverUrl, returnTo, signInEnvironment(page, basepath)),
  rememberServer: (serverUrl) => {
    page.history.replaceState(
      null,
      '',
      `${page.location.pathname}${searchWithServerUrl(page.location.search, serverUrl)}`
    )
  },
  leave: (authorizationUrl) => {
    page.location.assign(authorizationUrl)
  },
})

/**
 * Boot the page: redeem the sign-in this load returned with, if any, and
 * settle the address bar.
 *
 * - **Signed in**: the URL becomes the route the sign-in was started from
 *   (the app root by default) with `?iss=` naming the server, so a reload or a
 *   bookmark signs back in to it. The authorization response leaves the URL
 *   with it: the code is single-use.
 * - **Signed out**: a failed return leg takes the authorization response out
 *   of the URL and points `?iss=` back at the server it was to, so the landing
 *   offers it again beside the problem, and does not sign in on arrival. A
 *   deep link opened signed out rides the sign-in as its `returnTo`.
 */
const browserBoot = async (page: BootPage, basepath: string): Promise<Boot> => {
  const returnSearch = page.location.search
  const finished = await finishSignIn(returnSearch, signInEnvironment(page, basepath))
  if (finished.tag === 'Ok' && Option.isSome(finished.value)) {
    const session = finished.value.value
    page.history.replaceState(
      null,
      '',
      `${underBasepath(basepath, inAppReturnPath(session.returnTo))}${searchWithServerUrl('', session.serverUrl)}`
    )
    return { tag: 'SignedIn', session }
  }

  const bootSignInProblem = finished.tag === 'Failed' ? finished.problem : undefined
  if (isAuthorizationResponse(returnSearch)) {
    const withoutResponse = searchWithoutAuthorizationResponse(returnSearch)
    const failedServerUrl = bootSignInProblem?.serverUrl
    page.history.replaceState(
      null,
      '',
      `${page.location.pathname}${
        failedServerUrl === undefined
          ? withoutResponse
          : searchWithServerUrl(withoutResponse, failedServerUrl)
      }`
    )
  }

  return {
    tag: 'SignedOut',
    landing: {
      arrivalServerUrl: serverUrlFromSearch(page.location.search),
      bootSignInProblem,
      pageIsSecure: page.location.protocol === 'https:',
      signIn: browserLandingSignIn(page, basepath, deepRouteOf(page.location.pathname, basepath)),
    },
  }
}

export { browserBoot, deepRouteOf, underBasepath }
export type { Boot, BootPage }
