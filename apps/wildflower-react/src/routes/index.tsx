import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import {
  insecureTargetReason,
  normalizeServerUrl,
  searchWithServerUrl,
  serverUrlFromSearch,
} from 'gatekeeper-core/smart-client'
import { type JSX, type SubmitEvent, useEffect, useState } from 'react'
import { isAuthed, useSubscribable, useAuthStateSubscribable } from 'react-kitchen-sink'
import { TextField, pageLayoutStyles } from 'react-tundraish'

import type { RouterContext } from '../router-context.ts'
import { signInEnvironment, startSignIn } from '../sign-in.ts'
import { apiServerUrl, DEFAULT_SERVER_URL } from '../web-entry.ts'

const WILDFLOWER_DOMAIN = '.wildflowerhealth.io'

/**
 * Record `serverUrl` as this page's target without reloading.
 *
 * `?server=` is what `web-entry.ts` reads to point the transport, so it has
 * to be in the URL — but a reload is not needed to get there and would only
 * throw away the page mid-action. It survives the sign-in round trip anyway:
 * the registered redirect carries no query, so `main-web`'s boot restores
 * `?server=` from the redeemed session rather than from the address bar.
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
 * - **Every other entry**: redirects to `/home` unconditionally. They are
 *   served by the API server itself, so there is no server to pick, and their
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

/**
 * The web entry's landing page: pick a server, then sign in to it.
 *
 * @param bootSignInProblem - Why a sign-in failed on the *previous* page load,
 *   before this tree existed. `main-web` redeems the authorization code
 *   ahead of mounting the router, so that failure has to be carried in rather
 *   than raised here. Seeds the state once; a fresh attempt replaces it.
 */
function Landing({ bootSignInProblem }: { readonly bootSignInProblem?: string }): JSX.Element {
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

  if (authed) return <></>

  // The server this page is pointed at — the same resolution `web-entry.ts`
  // gives the transport, so the token is asked of whichever server the requests
  // will go to.
  const serverUrl = apiServerUrl(window.location.search)

  // Said up front, while the reader is still looking at the address they
  // entered, rather than later as a discovery failure: an https page cannot
  // reach a plaintext server unless it is loopback.
  const blockedReason = insecureTargetReason(serverUrl, {
    pageIsSecure: window.location.protocol === 'https:',
  })

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
    void startSignIn(target, signInEnvironment(window)).then((started) => {
      if (started.tag === 'Ok') {
        window.location.assign(started.value)
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
    const blocked = insecureTargetReason(normalized, {
      pageIsSecure: window.location.protocol === 'https:',
    })
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

  // A failed attempt outranks the up-front warning: the reader has already
  // acted, so what went wrong is the more useful thing to read.
  const status = signInProblem ?? blockedReason

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
          {/* Shown only when a server is already chosen — a reader who arrived
              on a shared link, or who was bounced here by the auth gate, has
              nothing to pick and just needs the way back in. Picking a server
              above signs in on its own, so this would be a dead second step
              otherwise. */}
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
        </div>
      </section>
    </div>
  )
}

export { Landing, Route }
