import './instrument.ts'
import { createBrowserHistory } from '@tanstack/react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { basenameOf, restoreRedirectedUrl } from 'branding-core'
import { Option } from 'effect'
import {
  isAuthorizationResponse,
  searchWithoutAuthorizationResponse,
  searchWithServerUrl,
  type Session,
} from 'gatekeeper-core/smart-client'
import type { TokenResponseHandler } from 'gatekeeper-react'
import { addOsColorSchemeListener } from 'react-tundraish'
import './styles/global.css'
import { renderApp } from './app-root.tsx'
import { finishSignIn, signInEnvironment, authStateForSession } from './sign-in.ts'
import { makeWebEntryOptions } from './web-entry.ts'

addOsColorSchemeListener()

// The directory this build is served from, captured as the router's `basepath`.
//
// `base: './'` in `vite.config.web.ts` makes the bundle path-independent, so one
// build serves both `/app/` and a PR preview's `/staging/pr-<n>/app/`; the
// router still has to be told which, or its root-absolute routes miss under the
// subpath and the app renders its own not-found (what #719's preview hit).
//
// Read here, at the top of the module, because every boot lands on the app root
// — a fresh load of it, or a 404 redirect that bounced there (see below) — so
// `location.pathname` is the served directory. It MUST be read before
// `restoreRedirectedUrl` rewrites a deep redirected route back into the bar,
// after which `basenameOf` would fold that route's own segments into the answer.
const basepath = basenameOf(window.location.pathname)

// Complete a GitHub Pages 404 redirect before anything reads the URL — see
// "The 404 redirect" in `slices/branding/AGENTS.md`. Ahead of both the
// return-leg check and the `?server=` read below.
restoreRedirectedUrl(window)

/** Rewrite the query string, keeping the path this load landed on. */
const replaceSearch = (search: string): void => {
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search}${window.location.hash}`
  )
}

/**
 * Put the signed-in server back in the address bar, and take the authorization
 * response out of it.
 *
 * Both happen in one rewrite because the new query is built from an empty
 * string rather than from the one the browser arrived on. `?server=` has to be
 * *restored* rather than kept: the registered redirect URI carries no query, so
 * by the callback the parameter is gone, and `web-entry.ts` derives
 * `apiBaseUrl` from it — left alone, the page would sign in to one server and
 * send every request to the loopback default. The `code`/`state` have to go for
 * the usual reason: the code is single-use and already redeemed, but left in the
 * URL it would sit in history and in anything the reader copies out of the bar.
 */
const settleUrlAfterSignIn = (session: Session): void => {
  replaceSearch(searchWithServerUrl('', session.serverUrl))
}

/**
 * Redeem an authorization code, if this load is a return leg, and only then
 * mount the app.
 *
 * The order is the point. The flow returns to `/home`, which sits behind the
 * `_auth` gate, and the bearer store starts `Unauthed` on every load (the token
 * is in page memory only). A router mounted before the exchange settled would
 * run that gate against an empty store and redirect to `/` while the token was
 * still in flight, so the sign-in would appear to fail every time. An ordinary
 * load pays a microtask for this: with no pending record, `completeSignIn`
 * resolves to `None` without touching the network.
 */
const boot = async (): Promise<void> => {
  const returnSearch = window.location.search
  const completed = await finishSignIn(returnSearch, signInEnvironment(window))
  const session = completed.tag === 'Ok' ? Option.getOrUndefined(completed.value) : undefined

  if (session !== undefined) settleUrlAfterSignIn(session)
  else if (isAuthorizationResponse(returnSearch)) {
    // A return leg that resolved to nothing usable: the response still has to
    // leave the URL, or a reload would replay a code that is already spent.
    replaceSearch(searchWithoutAuthorizationResponse(returnSearch))
  }

  // Built after the rewrite above, because it reads `?server=`.
  const { bearerStore, ...entryOptions } = makeWebEntryOptions()

  if (session !== undefined) {
    // The bearer is held first and the signal set second: the store publishes
    // nothing on a write, because a token response that reported no lifetime
    // has no honest `exp`. See `authStateForSession`.
    bearerStore.writeBearer(session.accessToken)
    bearerStore.setAuthState(authStateForSession(session, Math.floor(Date.now() / 1000)))
  }

  const history = createBrowserHistory()

  const tokenResponseHandler: TokenResponseHandler = {
    writeBearer: bearerStore.writeBearer,
    navigateAfterAuth: (returnTo) => {
      history.push(returnTo)
    },
  }

  renderApp({
    history,
    entry: 'main-web',
    basepath,
    ...entryOptions,
    tokenResponseHandler,
    ...(completed.tag === 'Failed' ? { signInProblem: completed.reason } : {}),
  })
}

void boot()
