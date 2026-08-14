import { createApiReference } from '@scalar/api-reference'
import { Effect, Option } from 'effect'

import '@scalar/api-reference/style.css'
import './styles.css'

import { searchWithoutAuthorizationResponse } from './authorization-flow.ts'
import { consoleConfiguration } from './configuration.ts'
import { searchWithServerUrl, serverUrlFromSearch } from './server-target.ts'
import {
  beginSignIn,
  completeSignIn,
  type Session,
  type SignInEnvironment,
  type SignInError,
} from './sign-in.ts'
import { REGISTERED_REDIRECT_URI, signInAvailability } from './smart-client.ts'

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

const referenceContainer = requireElement('#reference', HTMLElement)
const serverForm = requireElement('#server-form', HTMLFormElement)
const serverInput = requireElement('#server-url', HTMLInputElement)
const signInButton = requireElement('#sign-in', HTMLButtonElement)
const statusLine = requireElement('#auth-status', HTMLParagraphElement)

const prefersDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches

let reference: ReturnType<typeof createApiReference> | undefined

/**
 * The signed-in session, or `undefined`. **In memory only, deliberately**: the
 * token this holds can be admin-capable and the console is a public page, so it
 * is never written to `localStorage`, `sessionStorage` or a cookie, and it dies
 * with the tab (`slices/gatekeeper/docs/Auth Token Storage Explanation.md`).
 */
let session: Session | undefined

/** The impure edges the sign-in flow runs against in the browser. */
const signInEnvironment: SignInEnvironment = {
  fetch: (...args) => globalThis.fetch(...args),
  random: window.crypto,
  subtle: window.crypto.subtle,
  store: window.sessionStorage,
  redirectUri: REGISTERED_REDIRECT_URI,
  pageIsSecure: window.location.protocol === 'https:',
}

/** Whether this copy of the console is the one the client is registered for. */
const availability = signInAvailability(window.location.href)

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
 * try. `Effect.match` folds both channels away, so the promise never rejects.
 */
const runSignInEffect = <A>(
  effect: Effect.Effect<A, SignInError>,
  onSuccess: (value: A) => void
): void => {
  void Effect.runPromise(
    effect.pipe(
      Effect.match({
        onSuccess,
        onFailure: (error: SignInError) => {
          signInButton.disabled = !availability.available
          showStatus(error.reason, 'problem')
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
  if (!availability.available) {
    signInButton.disabled = true
    signInButton.textContent = 'Sign in'
    signInButton.title = availability.reason
    showStatus(availability.reason, 'problem')
    return
  }
  signInButton.disabled = false
  if (session === undefined) {
    signInButton.textContent = 'Sign in'
    signInButton.title = `Sign in to ${serverUrl} to send authorised requests`
    // Signed out there is nothing to report, and a stale message from a failed
    // attempt against a different server would only mislead.
    showStatus(undefined)
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

const initialServerUrl = serverUrlFromSearch(window.location.search)
serverInput.value = initialServerUrl
render(initialServerUrl)
renderAuthControls(initialServerUrl)

// A return leg from `/oauth/authorize` looks like any other load until the query
// string is read, so every load asks. `?server=` is restored from the pending
// record rather than the URL: the registered redirect URI carries no query.
runSignInEffect(completeSignIn(window.location.search, signInEnvironment), (result) => {
  if (Option.isNone(result)) return
  clearAuthorizationResponseFromUrl()
  session = result.value
  applyServerUrl(result.value.serverUrl)
})
