import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { basenameOf } from 'branding-core'
import { AppLanding, fromApp, SiteFooter, SiteHeader } from 'branding-react'
import { withLocalNetworkAccessHint } from 'fhir-r4-react/smart'
import { insecureTargetReason, searchWithServerUrl } from 'gatekeeper-core/smart-client'
import { type JSX, useEffect, useRef, useState } from 'react'
import { isAuthed, useSubscribable, useAuthStateSubscribable } from 'react-kitchen-sink'
import { ErrorBanner } from 'react-tundraish'
import { ConnectMenu } from 'smart-app-react'

import type { RouterContext } from '../router-context.ts'
import { returnToOnPage, signInEnvironment, startSignIn, type SignInStep } from '../sign-in.ts'
import { apiServerUrl, chosenServerUrl, DEFAULT_SERVER_URL } from '../web-entry.ts'

import styles from './index.module.css'

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
 *   before this tree existed. `main-web` redeems the authorization code
 *   ahead of mounting the router, so that failure has to be carried in rather
 *   than raised here. Seeds the state once; a fresh attempt replaces it.
 * @param signIn - How to start a sign-in and leave for it; the browser's own by
 *   default.
 *
 * @remarks
 * A sign-in starts from one of two places, and its problem is shown where it
 * started, once. The page's own attempts — the boot redemption, the sign-in on
 * arrival, and the "Sign in to …" button — report in the banner above that
 * button. A pick on the menu reports in the menu's own banner, through the
 * problem its `connect` resolves to. Starting either kind clears the other's:
 * a pick drops the page's problem, and a page attempt remounts the menu (its
 * `key`), which drops the menu's. While either is in flight the other control
 * is disabled — the button by `leavingToSignIn`, the menu by `busy` — so a
 * second PKCE flow cannot start over the first.
 */
function Landing({
  bootSignInProblem,
  signIn = browserSignIn,
}: {
  readonly bootSignInProblem?: string
  readonly signIn?: LandingSignIn
}): JSX.Element {
  const navigate = useNavigate()
  const authSignal = useSubscribable(useAuthStateSubscribable())

  // The server this page is pointed at — the same resolution `web-entry.ts`
  // gives the transport, so the token is asked of whichever server the requests
  // will go to.
  const serverUrl = apiServerUrl(window.location.search, window.sessionStorage)
  const pageIsSecure = window.location.protocol === 'https:'

  /**
   * A problem for the page's banner: `reason`, followed by the Local Network
   * Access hint when `target` is a loopback server this secure page reached
   * for. The menu adds the same hint to the problems it shows itself.
   */
  const pageProblem = (reason: string, target: string): string =>
    withLocalNetworkAccessHint(reason, target, { pageIsSecure })

  const [signInProblem, setSignInProblem] = useState(() =>
    bootSignInProblem === undefined ? undefined : pageProblem(bootSignInProblem, serverUrl)
  )
  const [leavingToSignIn, setLeavingToSignIn] = useState(false)
  // Whether this page has started a sign-in: set by every attempt, read by the
  // sign-in on arrival below.
  const signInStarted = useRef(false)
  // Bumped when the page starts a sign-in of its own, remounting the menu so a
  // problem it showed for an earlier pick does not sit beside the new attempt's.
  const [pageSignInAttempt, setPageSignInAttempt] = useState(0)

  // Bounce an already-signed-in reader on to the app. In an effect, not in the
  // render body: `navigate` schedules a router state update, and calling it
  // while rendering updates a component mid-render (React warns, and under
  // StrictMode the render runs twice), so the navigation could be dropped and
  // leave the landing page sitting there authed.
  const authed = isAuthed(authSignal)
  useEffect(() => {
    if (authed) void navigate({ to: '/home' })
  }, [authed, navigate])

  // Said up front, while the reader is still looking at the address they
  // entered, rather than later as a discovery failure: an https page cannot
  // reach a plaintext server unless it is loopback.
  const blockedReason = insecureTargetReason(serverUrl, { pageIsSecure })

  /**
   * Leave for the authorization endpoint discovered at `target`'s FHIR base
   * (its `/fhir-r4` for a Wildflower origin, the URL itself for a plain SMART
   * server's base) — the SMART standalone launch, the same flow the
   * server-docs console runs — resolving to the problem to show
   * if it could not start, or `undefined` once the page is leaving. The reader
   * comes back to the app root with a code, which `main-web`'s boot redeems
   * before the router mounts, then settles on the gate's `returnTo` (`/home` by
   * default). Nothing is held here across the redirect but the pending record
   * in `sessionStorage`, which carries no credential.
   */
  const leaveToSignIn = (target: string): Promise<string | undefined> => {
    signInStarted.current = true
    setLeavingToSignIn(true)
    return signIn.start(target).then((started) => {
      if (started.tag === 'Ok') {
        signIn.leave(started.value)
        return undefined
      }
      setLeavingToSignIn(false)
      return started.reason
    })
  }

  /** The page's own sign-in to `target`, reporting in the page's banner. */
  const signInTo = (target: string): void => {
    setSignInProblem(undefined)
    setPageSignInAttempt((attempt) => attempt + 1)
    void leaveToSignIn(target).then((problem) => {
      setSignInProblem(problem === undefined ? undefined : pageProblem(problem, target))
    })
  }

  /**
   * The menu's `connect`: point the page at the picked server and start signing
   * in to it, which is what choosing a server means — a reader who picks one
   * wants to be signed in to it, not handed a second button. A plain SMART
   * server (the demo one) is picked by its FHIR base, which is what `?server=`
   * names and, having a path, the base its sign-in discovers at — on a retry
   * or a reload as much as on the pick. The problem goes back to
   * the menu, which shows it with the Local Network Access hint when that
   * applies, so it is returned without one.
   */
  const connect = (pickedUrl: string): Promise<string | undefined> => {
    setSignInProblem(undefined)
    const blocked = insecureTargetReason(pickedUrl, { pageIsSecure })
    if (blocked !== undefined) return Promise.resolve(blocked)
    rememberServer(pickedUrl)
    return leaveToSignIn(pickedUrl)
  }

  // Keyed on a server the page can actually use, not on a `?server=`'s bare
  // presence: a junk value falls back to the loopback default, and offering
  // "Sign in to http://127.0.0.1:8080" to a reader whose address bar says
  // something else names the wrong server on the one control that hands out a
  // token.
  const hasChosenServer =
    chosenServerUrl(window.location.search, window.sessionStorage) !== undefined

  // Sign in on arrival, once, and only if nothing has started one yet. The ref
  // keeps a re-render (or StrictMode's double effect) from starting a second
  // flow while the first is still in hand — including the re-render after a
  // pick on the menu, whose `?server=` makes this page look newly arrived.
  const signInOnArrival =
    !authed && shouldSignInOnArrival({ hasChosenServer, blockedReason, bootSignInProblem })
  useEffect(() => {
    if (!signInOnArrival || signInStarted.current) return
    signInTo(serverUrl)
    // `signInTo` is rebuilt every render; the ref, not the deps, is the guard.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [signInOnArrival, serverUrl])

  if (authed) return <></>

  // A failed attempt outranks the up-front warning: the reader has already
  // acted, so what went wrong is the more useful thing to read.
  const status = signInProblem ?? blockedReason

  return (
    <div className={styles['landing-page']}>
      <SiteHeader nav={fromApp} />
      <main className={styles['connect-page']}>
        <AppLanding app="app">
          {status === undefined && !hasChosenServer ? null : (
            <div className={styles['sign-in']}>
              <ErrorBanner error={status} />
              {/* Shown only when a server is already chosen. Such a page signs
                  in on arrival, so this is the way back in when that couldn't
                  run or failed (the reason shows above). Picking a server on
                  the menu signs in on its own, so this would be a dead second
                  step otherwise. */}
              {hasChosenServer ? (
                <button
                  type="button"
                  className={`button-2 filled ${styles['sign-in__button']}`}
                  onClick={() => {
                    signInTo(serverUrl)
                  }}
                  disabled={leavingToSignIn || blockedReason !== undefined}
                >
                  {leavingToSignIn ? 'Taking you to sign in…' : `Sign in to ${serverUrl}`}
                </button>
              ) : null}
            </div>
          )}
          <ConnectMenu
            key={pageSignInAttempt}
            target="wildflower"
            localOrigin={DEFAULT_SERVER_URL}
            connect={connect}
            busy={leavingToSignIn}
          />
        </AppLanding>
      </main>
      <SiteFooter />
    </div>
  )
}

export { Landing, Route, shouldSignInOnArrival }
export type { LandingSignIn }
