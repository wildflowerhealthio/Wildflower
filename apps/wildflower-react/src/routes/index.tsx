import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { basenameOf } from 'branding-core'
import { AppLandingPage } from 'branding-react'
import { withLocalNetworkAccessHint } from 'fhir-r4-react/smart'
import { insecureTargetReason, searchWithServerUrl } from 'gatekeeper-core/smart-client'
import { type JSX, useEffect } from 'react'
import { isAuthed, useSubscribable, useAuthStateSubscribable } from 'react-kitchen-sink'
import { ConnectMenu } from 'smart-app-react'

import type { RouterContext } from '../router-context.ts'
import {
  returnToOnPage,
  signInEnvironment,
  startSignIn,
  type SignInProblem,
  type SignInStep,
} from '../sign-in.ts'
import { apiServerUrl, chosenServerUrl, DEFAULT_SERVER_URL } from '../web-entry.ts'

/**
 * Record `serverUrl` as this page's target without reloading.
 *
 * `?server=` is what `web-entry.ts` reads to point the transport, so it has
 * to be in the URL — but a reload is not needed to get there and would only
 * throw away the page mid-action. It does not survive the sign-in round trip,
 * and does not need to: the registered redirect carries no query, and
 * `main-web`'s boot remembers the redeemed session's server in the tab's
 * `sessionStorage`, leaving `?server=` out of the settled URL.
 *
 * The current `pathname` is kept, not replaced with `/`: this build is served
 * under a subpath (`/app/`, or a PR preview's `/staging/pr-<n>/app/`), so a
 * hardcoded root would move the reader off the app onto the origin root and
 * point `?server=` at a page that is not this app.
 */
const rememberServer = (serverUrl: string): void => {
  const search = searchWithServerUrl(window.location.search, serverUrl)
  window.history.replaceState(null, '', `${window.location.pathname}${search}`)
}

/**
 * Root index. Behavior varies by entry:
 *
 * - **`main-web` + unauthed**: renders the landing page (the owner UI's
 *   introduction beside the server picker), which signs in by SMART standalone
 *   launch — see `../sign-in.ts` for the flow and why this entry uses it
 *   rather than the device-code screen.
 * - **`main-web` + authed**: redirects to `/home`.
 * - **`main-tauri`**: redirects to `/home` unconditionally. The host webview
 *   talks to its own loopback server, so there is no server to pick, and the
 *   `_auth` gate handles the auth check.
 */
const Route = createFileRoute('/')({
  beforeLoad: ({ context }: { readonly context: RouterContext }): void => {
    if (context.entry !== 'main-web') {
      throw redirect({ to: '/home' })
    }
  },
  component: LandingRoute,
})

/**
 * Reads the one piece of router context the landing page needs and hands it
 * down, so {@link Landing} itself takes plain props and mounts in a test
 * under a bare router — the arrangement `settings/index.tsx` uses.
 */
function LandingRoute(): JSX.Element {
  const bootProblem = Route.useRouteContext({
    select: (context: RouterContext) => context.signInProblem,
  })
  return <Landing bootSignInProblem={bootProblem} />
}

/** How the landing page starts a sign-in and leaves for it — injected by tests. */
interface LandingSignIn {
  /** Begin a SMART sign-in against `target`, yielding the authorization URL. */
  readonly start: (target: string) => Promise<SignInStep<string>>
  /** Leave for the authorization server at `authorizationUrl`. */
  readonly leave: (authorizationUrl: string) => void
}

/**
 * The real {@link LandingSignIn}. Sign-in only starts from this landing, which
 * sits at the app root, so the page's own directory is the served base — the
 * same value `main-web` hands the router and the callback re-derives (see
 * `sign-in.ts`). The gate's `?returnTo=` rides the pending record, because the
 * registered redirect URI drops it.
 */
const browserSignIn: LandingSignIn = {
  start: (target) =>
    startSignIn(
      target,
      returnToOnPage(window.location.href),
      signInEnvironment(window, basenameOf(window.location.pathname))
    ),
  leave: (authorizationUrl) => {
    window.location.assign(authorizationUrl)
  },
}

/**
 * Whether the landing should start signing in as soon as it opens, rather than
 * wait for a click: the page already has a usable server (named by the URL, as
 * in a server's own link into the app or the auth gate's bounce, or remembered
 * from this tab's last sign-in, as after a reload or an expiry), that server is
 * reachable from this page, and no sign-in has just failed — retrying one on
 * arrival would loop the reader through the authorization server.
 */
const shouldSignInOnArrival = (arrival: {
  readonly hasChosenServer: boolean
  readonly blockedReason: string | undefined
  readonly bootSignInProblem: string | undefined
}): boolean =>
  arrival.hasChosenServer &&
  arrival.blockedReason === undefined &&
  arrival.bootSignInProblem === undefined

/**
 * The web entry's landing page, in the shared Wildflower chrome: the owner
 * UI's `APP_DESCRIPTIONS` introduction beside the `ConnectMenu`, where picking
 * a server signs in to it. Opened already naming a server, it signs in straight
 * away (see {@link shouldSignInOnArrival}).
 *
 * @param bootSignInProblem - Why a sign-in failed on the *previous* page load,
 *   before this tree existed, and the server it was to. `main-web` redeems the
 *   authorization code ahead of mounting the router, so that failure has to be
 *   carried in rather than raised here. The menu shows it until a fresh
 *   attempt starts.
 * @param signIn - How to start a sign-in and leave for it; the browser's own by
 *   default.
 *
 * @remarks
 * The page keeps only the policy: which server it is pointed at, whether to
 * sign in to it on arrival, what failed before it loaded, and what signing in
 * means (`connect`). The menu runs every sign-in — a pick, the "Sign in to …"
 * row for the chosen server, and the sign-in on arrival (`autoConnect`) —
 * through one in-flight state, so a problem shows once, beside where it
 * started, a second PKCE flow cannot start over the first, and Back from the
 * authorization server (a back-forward cache restore) leaves nothing disabled.
 */
function Landing({
  bootSignInProblem,
  signIn = browserSignIn,
}: {
  readonly bootSignInProblem?: SignInProblem
  readonly signIn?: LandingSignIn
}): JSX.Element {
  const navigate = useNavigate()
  const authSignal = useSubscribable(useAuthStateSubscribable())

  // Bounce an already-signed-in reader on to the app. In an effect, not in the
  // render body: `navigate` schedules a router state update, and calling it
  // while rendering updates a component mid-render (React warns, and under
  // StrictMode the render runs twice), so the navigation could be dropped and
  // leave the landing page sitting there authed.
  const authed = isAuthed(authSignal)
  useEffect(() => {
    if (authed) void navigate({ to: '/home' })
  }, [authed, navigate])

  if (authed) return <></>

  // The server this page is pointed at — the same resolution `web-entry.ts`
  // gives the transport, so the token is asked of whichever server the requests
  // will go to.
  const serverUrl = apiServerUrl(window.location.search, window.sessionStorage)
  const pageIsSecure = window.location.protocol === 'https:'

  // Said up front, while the reader is still looking at the address they
  // entered, rather than later as a discovery failure: an https page cannot
  // reach a plaintext server unless it is loopback.
  const blockedReason = insecureTargetReason(serverUrl, { pageIsSecure })

  /**
   * `problem`'s reason, followed by the Local Network Access hint when the
   * server the failed sign-in was to is a loopback one and this page is
   * secure.
   */
  const arrivalProblemFor = (problem: SignInProblem): string =>
    problem.serverUrl === undefined
      ? problem.reason
      : withLocalNetworkAccessHint(problem.reason, problem.serverUrl, { pageIsSecure })

  // Keyed on a server the page can actually use, not on a `?server=`'s bare
  // presence: a junk value falls back to the loopback default, and offering
  // "Sign in to http://127.0.0.1:8080" to a reader whose address bar says
  // something else names the wrong server on the one control that hands out a
  // token.
  const hasChosenServer =
    chosenServerUrl(window.location.search, window.sessionStorage) !== undefined

  /**
   * The menu's `connect`, for a pick and for the chosen server alike: point the
   * page at the server and leave for the authorization endpoint discovered at
   * its FHIR base (its `/fhir-r4` for a Wildflower server; the URL itself, on a
   * 404 there, for a plain SMART server's base) — the SMART standalone launch, the same flow the
   * server-docs console runs. Resolves to the problem to show if it could not
   * start, or `undefined` once the page is leaving. The reader comes back to
   * the app root with a code, which `main-web`'s boot redeems before the router
   * mounts, then settles on the gate's `returnTo` (`/home` by default). Nothing
   * is held here across the redirect but the pending record in
   * `sessionStorage`, which carries no credential.
   *
   * The problem goes back bare: the menu adds the Local Network Access hint
   * when it applies, and has already refused a plain-http server this https
   * page could not reach.
   */
  const connect = (targetUrl: string): Promise<string | undefined> => {
    rememberServer(targetUrl)
    return signIn.start(targetUrl).then((started) => {
      if (started.tag === 'Failed') return started.reason
      signIn.leave(started.value)
      return undefined
    })
  }

  return (
    <AppLandingPage app="app">
      <ConnectMenu
        target="wildflower"
        localOrigin={DEFAULT_SERVER_URL}
        connect={connect}
        // The boot failure was about the server that sign-in was to, which
        // a failed redemption leaves the address bar no longer naming, so
        // its Local Network Access hint is for that server; the menu adds
        // it to the problems of the sign-ins it runs itself.
        arrivalProblem={
          bootSignInProblem === undefined ? undefined : arrivalProblemFor(bootSignInProblem)
        }
        // Only when one is chosen: the sign-in on arrival is for it, and
        // this is the way back in when that couldn't run or failed.
        // Picking a server signs in on its own, so this would be a dead
        // second step otherwise.
        chosenServer={hasChosenServer ? { url: serverUrl, blockedReason } : undefined}
        // Read once, when the menu mounts: a pick's `?server=` must not
        // make this page look newly arrived and start a second sign-in.
        autoConnect={shouldSignInOnArrival({
          hasChosenServer,
          blockedReason,
          bootSignInProblem: bootSignInProblem?.reason,
        })}
      />
    </AppLandingPage>
  )
}

export { Landing, Route, shouldSignInOnArrival }
export type { LandingSignIn }
