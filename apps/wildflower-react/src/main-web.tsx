import './instrument.ts'
import { createBrowserHistory } from '@tanstack/react-router'
import 'react-tundraish/styles'
import { basenameOf, restoreRedirectedUrl } from 'branding-core'
import { Option } from 'effect'
import {
  isAuthorizationResponse,
  searchWithoutAuthorizationResponse,
  type Session,
} from 'gatekeeper-core/smart-client'
import { sanitizeReturnTo, type TokenResponseHandler } from 'gatekeeper-react'
import { addOsColorSchemeListener } from 'react-tundraish'
import './styles/global.css'
import { renderApp } from './app-root.tsx'
import {
  authStateForSession,
  finishSignIn,
  postSignInUrl,
  scheduleExpiry,
  signInEnvironment,
  takeReturnTo,
} from './sign-in.ts'
import { makeWebEntryOptions, underBasepath } from './web-entry.ts'

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
 * Land on where the reader was headed, put the signed-in server back in the
 * address bar, and take the authorization response out of it — in one rewrite.
 *
 * `returnTo` is the sanitised path the auth gate bounced (or `/home`); the URL
 * is rebuilt from it rather than from the address the browser arrived on, which
 * is what drops the callback's single-use `?code=`/`?state=` (left in the URL
 * they would sit in history and in anything the reader copies out of the bar).
 * `?server=` has to be *restored* rather than kept: the registered redirect URI
 * carries no query, so by the callback the parameter is gone, and `web-entry.ts`
 * derives `apiBaseUrl` from it — left alone, the page would sign in to one
 * server and send every request to the loopback default.
 */
const settleUrlAfterSignIn = (session: Session, returnTo: string): void => {
  window.history.replaceState(
    null,
    '',
    postSignInUrl(returnTo, session.serverUrl, window.location.origin)
  )
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
  // The same `basepath` the router gets, so the callback re-derives the exact
  // `redirect_uri` the outbound leg sent from the app root — see `sign-in.ts`.
  const completed = await finishSignIn(returnSearch, signInEnvironment(window, basepath))
  const session = completed.tag === 'Ok' ? Option.getOrUndefined(completed.value) : undefined

  if (session !== undefined) {
    // Read the stashed return path (the gate's `?returnTo=`, carried across the
    // redirect in `sessionStorage`) and honour it once, sanitised — same rules
    // as `NeedsAuthMessage`'s device-flow return leg.
    settleUrlAfterSignIn(session, sanitizeReturnTo(takeReturnTo(window)))
  } else if (isAuthorizationResponse(returnSearch)) {
    // A return leg that resolved to nothing usable: the response still has to
    // leave the URL, or a reload would replay a code that is already spent.
    replaceSearch(searchWithoutAuthorizationResponse(returnSearch))
  }

  // Built after the rewrite above, because it reads `?server=`.
  const { bearerStore, ...entryOptions } = makeWebEntryOptions(basepath)

  if (session !== undefined) {
    // The bearer is held first and the signal set second: the store publishes
    // nothing on a write, because a token response that reported no lifetime
    // has no honest `exp`. See `authStateForSession`.
    bearerStore.writeBearer(session.accessToken)
    bearerStore.setAuthState(authStateForSession(session, Math.floor(Date.now() / 1000)))
    // Drop the session back to `Unauthed` when the reported lifetime lapses, so
    // the next authed request redirects to the landing rather than 401-looping.
    scheduleExpiry(bearerStore.setAuthState, session.expiresInSeconds)
  }

  const history = createBrowserHistory()

  const tokenResponseHandler: TokenResponseHandler = {
    writeBearer: bearerStore.writeBearer,
    navigateAfterAuth: (returnTo) => {
      // `history.push` writes the address bar directly and does not apply the
      // router basepath (that is `router.navigate`'s job), so the served base
      // is prefixed here — otherwise the device-login return lands at
      // `<origin>/home`, off the app, on a subpath deploy.
      history.push(underBasepath(basepath, returnTo))
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
