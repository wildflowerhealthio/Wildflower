import { createBrowserHistory } from '@tanstack/react-router'
import '@wildflowerhealthio/react-tundraish/styles'
// The shared chrome's layout tokens, which the landing page's header, footer
// and `AppLanding` read. `branding-react`'s entry imports this stylesheet
// itself; naming it here too (one module, so one copy) puts it ahead of this
// app's own `global.css`, after the design system it builds on.
import '@wildflowerhealthio/branding-react/styles.css'
import {
  basenameOf,
  restoreRedirectedUrl,
  TELEMETRY_CONSENT_COPY,
} from '@wildflowerhealthio/branding-core'
import {
  isAuthorizationResponse,
  searchAfterArrivingLaunch,
} from '@wildflowerhealthio/gatekeeper-core/smart-client'
import { sanitizeReturnTo, type TokenResponseHandler } from '@wildflowerhealthio/gatekeeper-react'
import { addOsColorSchemeListener } from '@wildflowerhealthio/react-tundraish'
import { consentedTelemetryLayer } from '@wildflowerhealthio/telemetry-web'
import { Option } from 'effect'
import type { JSX } from 'react'
import './styles/global.css'
import { buildAppTree, mountAtRoot } from './app-root.tsx'
import { ConsentedEntryRoot } from './session/consented-entry-root.tsx'
import { ServerKind } from './session/server-kind.ts'
import {
  authStateForSession,
  finishSignIn,
  postSignInUrl,
  scheduleExpiry,
  serverKindForSession,
  signInEnvironment,
  unsentEhrLaunch,
} from './sign-in.ts'
import {
  apiServerUrl,
  ehrLaunchIn,
  makeWebEntryOptions,
  rememberSignedInServer,
  searchAfterReturnLeg,
  underBasepath,
} from './web-entry.ts'

addOsColorSchemeListener()

// The directory this build is served from, captured as the router's `basepath`.
//
// `base: './'` in `vite.config.web.ts` makes the bundle path-independent, so one
// build serves both `/launcher/` and a PR preview's `/staging/pr-<n>/launcher/`; the
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
// return-leg check, the SMART launch read and the `?server=` read in `boot`.
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
 * Land on where the reader was headed and take the authorization response out
 * of the address bar, in one rewrite.
 *
 * `returnTo` is the sanitised path the auth gate bounced (or `/home`). The URL
 * is rebuilt from it rather than from the address the browser arrived on, which
 * drops the callback's single-use `?code=`/`?state=`. Left in the URL, they
 * would sit in history and in anything the reader copies out of the bar. The
 * settled URL names no server: `boot` remembers the session's server in the
 * tab's `sessionStorage` instead (see `postSignInUrl`).
 */
const settleUrlAfterSignIn = (returnTo: string): void => {
  window.history.replaceState(null, '', postSignInUrl(returnTo, window.location.origin))
}

/**
 * Redeem an authorization code, if this load is a return leg, or read the SMART
 * launch it was opened with, if it is one, and only then build the app.
 *
 * The order is the point. The flow returns to the app root and settles on the
 * return path (`/home` by default), which sits behind the `_auth` gate, and the
 * bearer store starts `Unauthed` on every load (the token is in page memory
 * only). A router mounted before the exchange settled would run that gate
 * against an empty store and redirect to `/` while the token was still in
 * flight, so the sign-in would appear to fail every time. An ordinary load pays
 * a microtask for this: with no pending record, `completeSignIn` resolves to
 * `None` without touching the network.
 *
 * `ConsentedEntryRoot` calls this once the visitor has answered the telemetry
 * consent dialog, so nothing here runs before an answer.
 */
const bootApp = async (): Promise<JSX.Element> => {
  const returnSearch = window.location.search
  // The same `basepath` the router gets, so the callback re-derives the exact
  // `redirect_uri` the outbound leg sent from the app root — see `sign-in.ts`.
  const completed = await finishSignIn(returnSearch, signInEnvironment(window, basepath))
  const session = completed.tag === 'Ok' ? Option.getOrUndefined(completed.value) : undefined

  if (session !== undefined) {
    // The settled URL names no server, so the tab remembers the one that issued
    // the token: for the transport below, and for a reload or the expiry
    // bounce back to the landing.
    rememberSignedInServer(window.sessionStorage, session.serverUrl)
    // Honour the gate's `?returnTo=`, carried across the redirect in the
    // pending record, sanitised — same rules as `NeedsAuthMessage`'s
    // device-flow return leg.
    settleUrlAfterSignIn(sanitizeReturnTo(session.returnTo ?? null))
  } else if (isAuthorizationResponse(returnSearch)) {
    // A return leg that resolved to nothing usable: the response still has to
    // leave the URL, or a reload would replay a code that is already spent. A
    // failed one points `?server=` back at its server, so the landing offers
    // it beside the problem.
    replaceSearch(
      searchAfterReturnLeg(
        returnSearch,
        completed.tag === 'Failed' ? completed.problem.serverUrl : undefined
      )
    )
  }

  // A load opened with a SMART launch (`?iss=`, and `launch` for an EHR
  // launch — the base opening this server's launcher) is pointed at the server
  // `iss` names, and the launch leaves the URL, read once: a reload must not
  // offer gatekeeper a launch it has already spent. The landing signs in to
  // that server on arrival, with the EHR launch. A return leg is never a
  // launch too, so this leaves its settled URL as it is.
  const arrivalSearch = window.location.search
  const settledSearch = searchAfterArrivingLaunch(arrivalSearch)
  if (settledSearch !== arrivalSearch) replaceSearch(settledSearch)
  const arrivingEhrLaunch = ehrLaunchIn(arrivalSearch)

  // Resolved after the rewrites above: a redeemed sign-in has just remembered
  // its server, and the settled URL has no `?server=` to outrank it; a failed
  // return leg or a launch has just named its server in `?server=`.
  const { bearerStore, ...entryOptions } = makeWebEntryOptions(
    window,
    basepath,
    apiServerUrl(window.location.search, window.sessionStorage)
  )

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

  return buildAppTree({
    history,
    entry: 'main-web',
    basepath,
    ...entryOptions,
    // Empty until the visitor's answer turns performance on: this entry never
    // starts telemetry from the build's env.
    effectTelemetryLayer: consentedTelemetryLayer,
    tokenResponseHandler,
    // What the sign-in redeemed on this load found. With none, the shell is
    // reached only through the device-code flow, which only a Wildflower
    // server serves. A reload drops the bearer, and the landing signs back in
    // on arrival, so the kind is found again rather than remembered.
    serverKind: session === undefined ? ServerKind.Wildflower() : serverKindForSession(session),
    ...(completed.tag === 'Failed' ? { signInProblem: completed.problem } : {}),
    // The EHR launch the landing signs in with on arrival, when this load
    // was opened with one: held once for the page load, so a landing that
    // mounts again cannot offer it twice.
    ...(arrivingEhrLaunch === undefined ? {} : { ehrLaunch: unsentEhrLaunch(arrivingEhrLaunch) }),
  })
}

// The consent dialog first; the answer starts telemetry and then boots the app.
mountAtRoot(<ConsentedEntryRoot entry="main-web" copy={TELEMETRY_CONSENT_COPY} bootApp={bootApp} />)
