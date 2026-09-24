import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { basenameOf } from 'branding-core'
import {
  insecureTargetReason,
  normalizeServerUrl,
  searchWithServerUrl,
  serverUrlFromSearch,
} from 'gatekeeper-core/smart-client'
import { type JSX, type SubmitEvent, useEffect, useRef, useState } from 'react'
import { isAuthed, useSubscribable, useAuthStateSubscribable } from 'react-kitchen-sink'
import { TextField, pageLayoutStyles } from 'react-tundraish'

import { localNetworkAccessHint } from '../local-network-hint.ts'
import type { RouterContext } from '../router-context.ts'
import { returnToOnPage, signInEnvironment, startSignIn, type SignInStep } from '../sign-in.ts'
import { apiServerUrl, DEFAULT_SERVER_URL } from '../web-entry.ts'

const WILDFLOWER_DOMAIN = '.wildflowerhealth.io'

/**
 * Record `serverUrl` as this page's target without reloading.
 *
 * `?server=` is what `web-entry.ts` reads to point the transport, so it has
 * to be in the URL — but a reload is not needed to get there and would only
 * throw away the page mid-action. It does not survive the sign-in round trip,
 * and does not need to: the registered redirect carries no query, and
 * `main-web`'s boot points the transport at the redeemed session's server,
 * leaving `?server=` out of the settled URL.
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
 * - **`main-web` + unauthed**: renders the server picker landing page, which
 *   signs in by SMART standalone launch — see `../sign-in.ts` for the flow and
 *   why this entry uses it rather than the device-code screen.
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
 * wait for a click: the page was opened already naming a usable server (a
 * server's own link into the app, or the auth gate's bounce), that server is
 * reachable from this page, and no sign-in has just failed — retrying one on
 * arrival would loop the reader through the authorization server.
 */
const shouldSignInOnArrival = (arrival: {
  readonly hasServerInUrl: boolean
  readonly blockedReason: string | undefined
  readonly bootSignInProblem: string | undefined
}): boolean =>
  arrival.hasServerInUrl &&
  arrival.blockedReason === undefined &&
  arrival.bootSignInProblem === undefined

/**
 * The web entry's landing page: pick a server, then sign in to it. Opened
 * already naming a server, it signs in straight away (see
 * {@link shouldSignInOnArrival}).
 *
 * @param bootSignInProblem - Why a sign-in failed on the *previous* page load,
 *   before this tree existed. `main-web` redeems the authorization code
 *   ahead of mounting the router, so that failure has to be carried in rather
 *   than raised here. Seeds the state once; a fresh attempt replaces it.
 * @param signIn - How to start a sign-in and leave for it; the browser's own by
 *   default.
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
  const [subdomain, setSubdomain] = useState('')
  const [freeText, setFreeText] = useState('')
  const [signInProblem, setSignInProblem] = useState(bootSignInProblem)
  const [leavingToSignIn, setLeavingToSignIn] = useState(false)

  // Bounce an already-signed-in reader on to the app. In an effect, not in the
  // render body: `navigate` schedules a router state update, and calling it
  // while rendering updates a component mid-render (React warns, and under
  // StrictMode the render runs twice), so the navigation could be dropped and
  // leave the landing page sitting there authed.
  const authed = isAuthed(authSignal)
  useEffect(() => {
    if (authed) void navigate({ to: '/home' })
  }, [authed, navigate])

  // The server this page is pointed at — the same resolution `web-entry.ts`
  // gives the transport, so the token is asked of whichever server the requests
  // will go to.
  const serverUrl = apiServerUrl(window.location.search)
  const pageIsSecure = window.location.protocol === 'https:'

  // Said up front, while the reader is still looking at the address they
  // entered, rather than later as a discovery failure: an https page cannot
  // reach a plaintext server unless it is loopback.
  const blockedReason = insecureTargetReason(serverUrl, { pageIsSecure })

  /**
   * Leave for `target`'s `/oauth/authorize` — the SMART standalone launch, the
   * same flow the server-docs console runs. The reader comes back to `/home`
   * with a code, which `main-web`'s boot redeems before the router mounts.
   * Nothing is held here across the redirect but the pending record in
   * `sessionStorage`, which carries no credential.
   */
  const signInTo = (target: string): void => {
    setLeavingToSignIn(true)
    setSignInProblem(undefined)
    void signIn.start(target).then((started) => {
      if (started.tag === 'Ok') {
        signIn.leave(started.value)
        return
      }
      setLeavingToSignIn(false)
      setSignInProblem(started.reason)
    })
  }

  /**
   * Point the page at `candidate` and start signing in to it, which is what
   * choosing a server means — a reader who picks one wants to be signed in to
   * it, not handed a second button further down the page.
   */
  const connectToServer = (candidate: string): void => {
    const normalized = normalizeServerUrl(candidate)
    if (normalized === undefined) {
      setSignInProblem(`“${candidate}” is not an address this page can reach.`)
      return
    }
    const blocked = insecureTargetReason(normalized, { pageIsSecure })
    if (blocked !== undefined) {
      setSignInProblem(blocked)
      return
    }
    rememberServer(normalized)
    signInTo(normalized)
  }

  const handleLocal = (): void => {
    connectToServer(DEFAULT_SERVER_URL)
  }

  const handleSubdomain = (e: SubmitEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const trimmed = subdomain.trim()
    if (trimmed === '') return
    connectToServer(`https://${trimmed}${WILDFLOWER_DOMAIN}`)
  }

  const handleFreeText = (e: SubmitEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const trimmed = freeText.trim()
    if (trimmed === '') return
    connectToServer(trimmed)
  }

  // Keyed on a `?server=` the page can actually use, not on the parameter's
  // bare presence: a junk value falls back to the loopback default, and
  // offering "Sign in to http://127.0.0.1:8080" to a reader whose address bar
  // says something else names the wrong server on the one control that hands
  // out a token.
  const hasServerInUrl = serverUrlFromSearch(window.location.search) !== undefined

  // Sign in on arrival, once. The ref keeps a re-render (or StrictMode's double
  // effect) from starting a second flow while the first is still in hand.
  const signedInOnArrival = useRef(false)
  const signInOnArrival =
    !authed && shouldSignInOnArrival({ hasServerInUrl, blockedReason, bootSignInProblem })
  useEffect(() => {
    if (!signInOnArrival || signedInOnArrival.current) return
    signedInOnArrival.current = true
    signInTo(serverUrl)
    // `signInTo` is rebuilt every render; the ref, not the deps, is the guard.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [signInOnArrival, serverUrl])

  if (authed) return <></>

  // A failed attempt outranks the up-front warning: the reader has already
  // acted, so what went wrong is the more useful thing to read.
  const status = signInProblem ?? blockedReason

  // Only alongside an actual failure, and only for a loopback target from the
  // published page: a network/CORS failure there is most often Chrome holding
  // the request behind its Local Network Access prompt, which the reason on its
  // own cannot name. See `local-network-hint.ts`.
  const localNetworkHint =
    status === undefined ? undefined : localNetworkAccessHint(serverUrl, { pageIsSecure })

  return (
    <div className={pageLayoutStyles['page']}>
      <h1 className="text-heading-6">Wildflower</h1>
      <p className="text-body-2">
        Connect to a Wildflower server to manage devices, apps, and health data.
      </p>

      <section>
        <h2 className="text-heading-7">Connect to a server</h2>

        <div style={{ display: 'grid', gap: 'var(--space-7)', marginTop: 'var(--space-7)' }}>
          <button type="button" className="button-2 filled" onClick={handleLocal}>
            Local server ({new URL(DEFAULT_SERVER_URL).host})
          </button>

          <form
            onSubmit={handleSubdomain}
            style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'end' }}
          >
            <span className="text-body-3" style={{ marginBottom: 8 }}>
              https://
            </span>
            <TextField
              label="Subdomain"
              value={subdomain}
              onChange={setSubdomain}
              placeholder="my-server"
            />
            <span className="text-body-3" style={{ marginBottom: 8 }}>
              {WILDFLOWER_DOMAIN}
            </span>
            <button type="submit" className="button-3 outlined">
              Connect
            </button>
          </form>

          <form
            onSubmit={handleFreeText}
            style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'end' }}
          >
            <TextField
              label="Custom server URL"
              value={freeText}
              onChange={setFreeText}
              placeholder="https://my-server.example.com"
            />
            <button type="submit" className="button-3 outlined">
              Connect
            </button>
          </form>
        </div>

        <div style={{ marginTop: 'var(--space-9)', display: 'grid', gap: 'var(--space-5)' }}>
          {/* Shown only when a server is already chosen. Such a page signs in
              on arrival, so this is the way back in when that couldn't run or
              failed (the reason shows below). Picking a server above signs in
              on its own, so this would be a dead second step otherwise. */}
          {hasServerInUrl ? (
            <button
              type="button"
              className="button-2 filled"
              onClick={() => {
                signInTo(serverUrl)
              }}
              disabled={leavingToSignIn || blockedReason !== undefined}
            >
              {leavingToSignIn ? 'Taking you to sign in…' : `Sign in to ${serverUrl}`}
            </button>
          ) : null}
          {status === undefined ? null : <p className="text-body-3">{status}</p>}
          {localNetworkHint === undefined ? null : (
            <p className="text-body-3">{localNetworkHint}</p>
          )}
        </div>
      </section>
    </div>
  )
}

export { Landing, Route, shouldSignInOnArrival }
export type { LandingSignIn }
