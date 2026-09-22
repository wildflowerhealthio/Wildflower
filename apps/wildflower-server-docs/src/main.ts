import { createApiReference } from '@scalar/api-reference'
import { restoreRedirectedUrl } from 'branding-core'
import { Effect, Option } from 'effect'

import '@scalar/api-reference/style.css'
import './styles.css'

import {
  beginSignIn,
  browserSignInEnvironment,
  completeSignIn,
  insecureTargetReason,
  isAuthorizationResponse,
  redirectUriForPage,
  searchWithoutAuthorizationResponse,
  searchWithServerUrl,
  standaloneLaunchScopeParameter,
  type Session,
  type SignInEnvironment,
  type SignInError,
} from 'gatekeeper-core/smart-client'

import { consoleConfiguration } from './configuration.ts'
import { serverUrlFromSearch } from './server-target.ts'
import { PENDING_AUTHORIZATION_KEY, CLIENT_ID, REGISTERED_REDIRECT_URI } from './smart-client.ts'

/**
 * Boots the static Wildflower server-docs console: a Scalar API reference over
 * the six committed slice snapshots, targeted at whichever running server the
 * `?server=` parameter names (see `server-target.ts`), optionally signed in to
 * that server as the `wildflower-server-docs` SMART client (see `sign-in.ts`).
 *
 * DOM and history wiring only — the `?server=` parsing, the spec transforms, the
 * Scalar configuration and both halves of the OAuth flow are pure or injectable
 * functions in their own modules, where they are unit-tested. This file is also
 * the **one** place an Effect is run: `sign-in.ts` hands back `Effect`s whose
 * failures are tagged errors, and each `runSignInEffect` call below turns one
 * into a rendered status line.
 */

/** Look up a required element, narrowing to the concrete DOM class. */
const requireElement = <T extends Element>(
  selector: string,
  Constructor: abstract new () => T
): T => {
  const element = document.querySelector(selector)
  if (!(element instanceof Constructor)) {
    throw new Error(`Missing ${Constructor.name} at "${selector}"`)
  }
  return element
}

// Complete a GitHub Pages 404 redirect before anything reads the URL — see
// "The 404 redirect" in `slices/branding/AGENTS.md`.
// Ahead of the `?server=` read and the OAuth-callback check below, both of
// which parse `window.location.search`.
restoreRedirectedUrl(window)

const referenceContainer = requireElement('#reference', HTMLElement)
const serverForm = requireElement('#server-form', HTMLFormElement)
const serverInput = requireElement('#server-url', HTMLInputElement)
const signInButton = requireElement('#sign-in', HTMLButtonElement)
const statusLine = requireElement('#auth-status', HTMLParagraphElement)

const prefersDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches

/** Whether this page is a secure context, which decides what it may reach. */
const pageIsSecure = window.location.protocol === 'https:'

let reference: ReturnType<typeof createApiReference> | undefined

/**
 * The signed-in session, or `undefined`. **In memory only, deliberately**: the
 * token this holds can be admin-capable and the console is a public page, so it
 * is never written to `localStorage`, `sessionStorage` or a cookie, and it dies
 * with the tab (`slices/gatekeeper/docs/Auth Token Storage Explanation.md`).
 */
let session: Session | undefined

/**
 * The `redirect_uri` this copy returns to — its own directory URL, derived from
 * where the page is served (see "Sign-in works from wherever the console is
 * served" in the README). The fallback is unreachable from a page a browser
 * would run this script on, and the published URI is harmless if it ever is.
 */
const redirectUri = redirectUriForPage(window.location.href) ?? REGISTERED_REDIRECT_URI

/**
 * The impure edges the sign-in flow runs against in the browser, wired by
 * `gatekeeper-core/smart-client` so this console and the `wildflower-react`
 * page share one reading of `window` rather than a copy each.
 */
const signInEnvironment: SignInEnvironment = browserSignInEnvironment(window, {
  clientId: CLIENT_ID,
  pendingKey: PENDING_AUTHORIZATION_KEY,
  scope: standaloneLaunchScopeParameter(),
  redirectUri,
})

/** Show `message` on the status line, or clear it when `undefined`. */
const showStatus = (message: string | undefined, kind: 'ok' | 'problem' = 'ok'): void => {
  statusLine.textContent = message ?? ''
  statusLine.hidden = message === undefined
  statusLine.classList.toggle('server-bar__status--problem', kind === 'problem')
}

/**
 * The single boundary where a sign-in `Effect` is run.
 *
 * Both halves of the flow fail with a {@link SignInError}, and every variant of
 * it carries a `reason` written for a reader, so one handler renders them all:
 * the message goes on the status line and the button comes back for another
 * try. `Effect.match` folds both channels away, so the promise never rejects. An
 * optional `onFailure` runs after that shared handling, for a caller that must
 * still do something itself when its effect fails (the return leg mounts the
 * reference against the default target there, since success never will).
 */
const runSignInEffect = <A>(
  effect: Effect.Effect<A, SignInError>,
  onSuccess: (value: A) => void,
  onFailure?: (error: SignInError) => void
): void => {
  void Effect.runPromise(
    effect.pipe(
      Effect.match({
        onSuccess,
        onFailure: (error: SignInError) => {
          signInButton.disabled = false
          showStatus(error.reason, 'problem')
          onFailure?.(error)
        },
      })
    )
  )
}

/**
 * Mount (or re-mount) the reference against `serverUrl`. Re-targeting tears the
 * previous instance down rather than patching its configuration: the documents
 * themselves differ between targets, so a clean mount is the honest update — and
 * the same is true of signing in or out, which changes the token every source's
 * bearer field is prefilled with.
 *
 * The token is only offered to the server it was issued for: a reader who
 * re-points the console mid-session keeps their session, but the requests going
 * somewhere else go without it.
 */
const render = (serverUrl: string): void => {
  const accessToken = session?.serverUrl === serverUrl ? session.accessToken : undefined
  reference?.destroy()
  reference = createApiReference(
    referenceContainer,
    consoleConfiguration(serverUrl, { prefersDarkMode, accessToken })
  )
}

/** Put the sign-in button and the status line in step with the current state. */
const renderAuthControls = (serverUrl: string): void => {
  signInButton.disabled = false
  if (session === undefined) {
    signInButton.textContent = 'Sign in'
    signInButton.title = `Sign in to ${serverUrl} to send authorised requests`
    // Said up front, while the reader is still looking at the address they
    // entered, rather than later as a discovery failure.
    const blocked = insecureTargetReason(serverUrl, { pageIsSecure })
    showStatus(blocked, blocked === undefined ? 'ok' : 'problem')
    return
  }
  signInButton.textContent = 'Sign out'
  signInButton.title = 'Forget the access token this tab is holding'
  const scope = session.scope === '' ? 'no scopes reported' : session.scope
  showStatus(
    session.serverUrl === serverUrl
      ? `Signed in to ${session.serverUrl}. Granted: ${scope}.`
      : `Signed in to ${session.serverUrl}, which is not the server shown — requests go unauthenticated.`
  )
}

/**
 * The pending expiry-notice timer, or `undefined` when none is armed. Held so a
 * sign-out or a replacing sign-in can cancel a notice that no longer applies.
 */
let expiryTimer: ReturnType<typeof setTimeout> | undefined

/** Cancel any armed expiry notice. */
const cancelExpiryNotice = (): void => {
  if (expiryTimer !== undefined) {
    clearTimeout(expiryTimer)
    expiryTimer = undefined
  }
}

/**
 * Arm a notice for when `current`'s token lapses. The console holds the token in
 * memory only and does not refresh it, so an expired one would just 401 every
 * request it was prefilled into — silently. When the lifetime the server reported
 * runs out, the honest thing is to drop the now-useless session and tell the
 * reader to sign in again; the identity check keeps a stale timer from clearing a
 * session that has since been replaced. A token with no reported lifetime gets no
 * timer (nothing to count down).
 */
const scheduleExpiryNotice = (current: Session): void => {
  cancelExpiryNotice()
  if (current.expiresInSeconds === undefined) return
  expiryTimer = setTimeout(
    () => {
      expiryTimer = undefined
      if (session !== current) return
      session = undefined
      const serverUrl = serverUrlFromSearch(window.location.search)
      render(serverUrl)
      renderAuthControls(serverUrl)
      showStatus(
        `The access token from ${current.serverUrl} has expired. Sign in again to keep sending authorised requests.`,
        'problem'
      )
    },
    Math.max(0, current.expiresInSeconds * 1000)
  )
}

/**
 * Point the console at `candidate`, writing the canonical value back into both
 * the URL (so the configured console stays shareable) and the input, then
 * re-rendering. An unusable candidate falls back to the default target, exactly
 * as a fresh load of the resulting URL would.
 */
const applyServerUrl = (candidate: string): void => {
  const search = searchWithServerUrl(window.location.search, candidate)
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search}${window.location.hash}`
  )
  const serverUrl = serverUrlFromSearch(search)
  serverInput.value = serverUrl
  render(serverUrl)
  renderAuthControls(serverUrl)
}

serverForm.addEventListener('submit', (event) => {
  event.preventDefault()
  applyServerUrl(serverInput.value)
})

signInButton.addEventListener('click', () => {
  const serverUrl = serverUrlFromSearch(window.location.search)
  if (session !== undefined) {
    cancelExpiryNotice()
    session = undefined
    render(serverUrl)
    renderAuthControls(serverUrl)
    showStatus('Signed out. The access token is gone from this tab.')
    return
  }
  signInButton.disabled = true
  showStatus(`Asking ${serverUrl} how to sign in…`)
  runSignInEffect(beginSignIn(serverUrl, signInEnvironment), (authorizationUrl) => {
    window.location.assign(authorizationUrl)
  })
})

/**
 * Strip the authorization response from the address bar once it has been read.
 * The code is single-use and already redeemed by then, but leaving it in the URL
 * would put it in history and in anything the reader copies out of the bar.
 */
const clearAuthorizationResponseFromUrl = (): void => {
  const search = searchWithoutAuthorizationResponse(window.location.search)
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search}${window.location.hash}`
  )
}

const returnSearch = window.location.search
const returningFromAuthorization = isAuthorizationResponse(returnSearch)

const initialServerUrl = serverUrlFromSearch(returnSearch)
serverInput.value = initialServerUrl
renderAuthControls(initialServerUrl)

// Mount the reference now on an ordinary load. On a return leg, defer it: a
// successful sign-in re-targets the reference at the signed-in server, so mounting
// the multi-megabyte Scalar bundle against the loopback default first would only
// be torn down and rebuilt. Each way the return resolves below mounts it exactly
// once — `applyServerUrl` on success, `render` on a failed or empty return.
if (!returningFromAuthorization) render(initialServerUrl)

// A return leg from `/oauth/authorize` looks like any other load until the query
// string is read, so every load asks. `?server=` is restored from the pending
// record rather than the URL: the registered redirect URI carries no query.
runSignInEffect(
  completeSignIn(returnSearch, signInEnvironment),
  (result) => {
    if (Option.isNone(result)) {
      if (returningFromAuthorization) render(initialServerUrl)
      return
    }
    session = result.value
    scheduleExpiryNotice(result.value)
    applyServerUrl(result.value.serverUrl)
  },
  () => {
    if (returningFromAuthorization) render(initialServerUrl)
  }
)

// Scrub the authorization response from the address bar on every return leg,
// success or failure alike: `completeSignIn` has already captured `returnSearch`,
// so the single-use code/state (or error) no longer needs to sit in the URL,
// where a reload, the referrer or a copied link would carry it on. Safe to do
// synchronously — the token exchange redeems the code from the captured string,
// not from the live URL.
if (returningFromAuthorization) clearAuthorizationResponseFromUrl()
