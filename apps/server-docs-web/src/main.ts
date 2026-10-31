import { createApiReference } from '@scalar/api-reference'
import { restoreRedirectedUrl } from '@wildflowerhealthio/branding-core'
import { Effect, Either, Option } from 'effect'

import '@scalar/api-reference/style.css'
import './styles.css'

import {
  arrivingSmartLaunchFrom,
  beginSignIn,
  browserSignInEnvironment,
  completeSignIn,
  insecureTargetReason,
  isAuthorizationResponse,
  normalizeServerUrl,
  redirectUriForPage,
  searchWithServerUrl,
  serverUrlFromSearch,
  standaloneLaunchScopeParameter,
  type Session,
  type SignInEnvironment,
  type SignInError,
} from '@wildflowerhealthio/authorization-core/smart-client'

import {
  pendingSignInServerUrl,
  resetAuthControlsOnBackForwardRestore,
  searchSettledFrom,
} from './arrival.ts'
import { consoleConfiguration } from './configuration.ts'
import {
  CONNECT_CHOICES,
  CONNECT_HEADING,
  type ServerEntryChoice,
  type WithoutServerChoice,
} from './connect-choices.ts'
import { PENDING_AUTHORIZATION_KEY, CLIENT_ID, REGISTERED_REDIRECT_URI } from './smart-client.ts'

/**
 * Boots the static Wildflower server-docs console: a Scalar API reference over
 * the five committed slice snapshots, targeted at whichever running server the
 * `?server=` parameter names, optionally signed in to that server as the
 * console's SMART client (see `smart-client.ts` and `sign-in.ts`). With no
 * `?server=` it has no target: it shows the connect choices
 * (`connect-choices.ts`) and mounts no reference until the reader picks a
 * server, or launches without one.
 * Opened with a SMART launch (`?iss=`, with the EHR's `launch` when there is
 * one), it targets the server `iss` names and signs in to it straight away.
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
// Ahead of the SMART launch read, the `?server=` read and the OAuth-callback
// check below, all of which parse `window.location.search`.
restoreRedirectedUrl(window)

const referenceContainer = requireElement('#reference', HTMLElement)
const connectSection = requireElement('#connect', HTMLElement)
const serverTarget = requireElement('#server-target', HTMLParagraphElement)
const serverTargetUrl = requireElement('#server-target-url', HTMLSpanElement)
const changeServerButton = requireElement('#change-server', HTMLButtonElement)
const serverHint = requireElement('#server-hint', HTMLParagraphElement)
const signInButton = requireElement('#sign-in', HTMLButtonElement)
const statusLine = requireElement('#auth-status', HTMLParagraphElement)

const prefersDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches

/** Whether this page is a secure context, which decides what it may reach. */
const pageIsSecure = window.location.protocol === 'https:'

let reference: ReturnType<typeof createApiReference> | undefined

/**
 * Whether the reader chose **Launch without a server**. In memory only: it is
 * not written to the URL, so a reload or a shared link shows the connect
 * choices again.
 */
let browsingWithoutServer = false

/**
 * The signed-in session, or `undefined`. **In memory only, deliberately**: the
 * token this holds can be admin-capable and the console is a public page, so it
 * is never written to `localStorage`, `sessionStorage` or a cookie, and it dies
 * with the tab (`slices/authorization/docs/Auth Token Storage Explanation.md`).
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
 * `authorization-core/smart-client` so this console and the `launcher-web`
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

/** The server this page load targets, or `undefined` when its URL names none. */
const currentServerUrl = (): string | undefined => serverUrlFromSearch(window.location.search)

/**
 * The single boundary where a sign-in `Effect` is run.
 *
 * Both halves of the flow fail with a {@link SignInError}, and every variant of
 * it carries a `reason` written for a reader, so one handler renders them all:
 * the message goes on the status line and the buttons come back for another
 * try. `Effect.match` folds both channels away, so the promise never rejects. An
 * optional `onFailure` runs after that shared handling, for a caller that must
 * still do something itself when its effect fails (the return leg goes back to
 * the server the sign-in was for there, since success never will).
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
          changeServerButton.disabled = false
          showStatus(error.reason, 'problem')
          onFailure?.(error)
        },
      })
    )
  )
}

/**
 * Show the page for `serverUrl`: the target line and the reference mounted
 * (or re-mounted) against it, with no target when the reader is browsing
 * without a server; with neither, the connect choices and no reference.
 *
 * Re-targeting tears the previous instance down rather
 * than patching its configuration: the documents themselves differ between
 * targets, so a clean mount is the honest update — and the same is true of
 * signing in or out, which changes the token every source's bearer field is
 * prefilled with.
 *
 * The token is only offered to the server it was issued for. **Change server**
 * signs out, so that is the server shown; the check keeps it so regardless.
 */
const render = (serverUrl: string | undefined): void => {
  reference?.destroy()
  reference = undefined
  const choosing = serverUrl === undefined && !browsingWithoutServer
  connectSection.hidden = !choosing
  serverTarget.hidden = choosing
  changeServerButton.hidden = choosing
  serverHint.hidden = serverUrl === undefined
  serverTargetUrl.textContent = serverUrl ?? 'None'
  if (choosing) return
  const accessToken =
    serverUrl !== undefined && session?.serverUrl === serverUrl ? session.accessToken : undefined
  reference = createApiReference(
    referenceContainer,
    consoleConfiguration(serverUrl, { prefersDarkMode, accessToken })
  )
}

/**
 * Put the sign-in button and the status line in step with the current state.
 * With no target there is nothing to sign in to, so the button and the status
 * line go.
 */
const renderAuthControls = (serverUrl: string | undefined): void => {
  signInButton.disabled = false
  changeServerButton.disabled = false
  signInButton.hidden = serverUrl === undefined
  if (serverUrl === undefined) {
    showStatus(undefined)
    return
  }
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

/** Drop the signed-in session, and the expiry notice armed for it. */
const forgetSession = (): void => {
  cancelExpiryNotice()
  session = undefined
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
      const serverUrl = currentServerUrl()
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
 * Point the console at `serverUrl` (an empty string for none), writing its
 * canonical value into the URL, so the configured console stays shareable,
 * then re-rendering.
 */
const applyServerUrl = (serverUrl: string): void => {
  const search = searchWithServerUrl(window.location.search, serverUrl)
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search}${window.location.hash}`
  )
  const target = serverUrlFromSearch(search)
  browsingWithoutServer = false
  render(target)
  renderAuthControls(target)
}

/**
 * Leave for `serverUrl`'s authorization endpoint to sign in: an EHR launch
 * when `launch` is the one the console was opened with, a standalone launch
 * otherwise. **Sign in** and **Change server** stay disabled until the page
 * leaves, or the sign-in fails.
 */
const startSigningIn = (serverUrl: string, launch?: string): void => {
  signInButton.disabled = true
  changeServerButton.disabled = true
  showStatus(`Asking ${serverUrl} how to sign in…`)
  // The console is one page, so there is nowhere in particular to return to.
  runSignInEffect(
    beginSignIn(serverUrl, undefined, signInEnvironment, { launch }),
    (authorizationUrl) => {
      window.location.assign(authorizationUrl)
    }
  )
}

/**
 * Target the server a connect choice named and sign in to it, as **Sign in**
 * does — unless this page cannot reach it, which the status line then says.
 */
const connectTo = (serverUrl: string): void => {
  applyServerUrl(serverUrl)
  if (insecureTargetReason(serverUrl, { pageIsSecure }) === undefined) startSigningIn(serverUrl)
}

/**
 * One server entry as a form: its heading, its field, a line under the field
 * when it has one, its own validation message, then its Connect button.
 */
const serverEntryForm = (choice: ServerEntryChoice): HTMLFormElement => {
  const form = document.createElement('form')
  form.className = 'connect__group'
  form.setAttribute('aria-label', choice.name)
  form.noValidate = true

  const heading = document.createElement('h3')
  heading.className = 'connect__name'
  heading.textContent = choice.name

  const input = document.createElement('input')
  input.className = 'connect__input'
  input.type = 'text'
  input.inputMode = 'url'
  input.spellcheck = false
  input.placeholder = choice.placeholder

  // The field inside its label, so the two are associated without an id.
  const label = document.createElement('label')
  label.className = 'connect__label'
  label.append(choice.label, input)

  const problem = document.createElement('p')
  problem.className = 'connect__problem'
  problem.setAttribute('role', 'alert')
  problem.hidden = true

  const submit = document.createElement('button')
  submit.className = 'connect__button'
  submit.type = 'submit'
  submit.textContent = 'Connect'

  form.append(heading, label)
  if (choice.description !== undefined) {
    const description = document.createElement('p')
    description.className = 'connect__description'
    description.textContent = choice.description
    form.append(description)
  }
  form.append(problem, submit)

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    Either.match(choice.serverUrlFor(input.value), {
      onLeft: (message) => {
        problem.textContent = message
        problem.hidden = false
      },
      onRight: (serverUrl) => {
        problem.hidden = true
        connectTo(serverUrl)
      },
    })
  })
  return form
}

/** **Launch without a server**: what it gives, then its button. */
const withoutServerGroup = (choice: WithoutServerChoice): HTMLElement => {
  const group = document.createElement('section')
  group.className = 'connect__group'
  group.setAttribute('aria-label', choice.name)

  const heading = document.createElement('h3')
  heading.className = 'connect__name'
  heading.textContent = choice.name

  const description = document.createElement('p')
  description.className = 'connect__description'
  description.textContent = choice.description

  const button = document.createElement('button')
  button.className = 'connect__button'
  button.type = 'button'
  button.textContent = choice.buttonLabel
  button.addEventListener('click', () => {
    // No token outlives its target: browsing has none to offer one to.
    forgetSession()
    browsingWithoutServer = true
    render(undefined)
    renderAuthControls(undefined)
  })

  group.append(heading, description, button)
  return group
}

const connectHeading = document.createElement('h2')
connectHeading.id = 'connect-heading'
connectHeading.className = 'connect__heading'
connectHeading.textContent = CONNECT_HEADING
connectSection.append(
  connectHeading,
  ...CONNECT_CHOICES.map((choice) =>
    choice.kind === 'server-entry' ? serverEntryForm(choice) : withoutServerGroup(choice)
  )
)

// Back to the connect choices, signed out: the session belongs to the server
// being left, and with no target there is no Sign out to drop it with later.
changeServerButton.addEventListener('click', () => {
  forgetSession()
  applyServerUrl('')
})

signInButton.addEventListener('click', () => {
  const serverUrl = currentServerUrl()
  if (session !== undefined) {
    forgetSession()
    render(serverUrl)
    renderAuthControls(serverUrl)
    showStatus('Signed out. The access token is gone from this tab.')
    return
  }
  // Hidden without a target, so there is always one to sign in to here.
  if (serverUrl !== undefined) startSigningIn(serverUrl)
})

resetAuthControlsOnBackForwardRestore(window, () => {
  renderAuthControls(currentServerUrl())
})

const returnSearch = window.location.search
const returningFromAuthorization = isAuthorizationResponse(returnSearch)
const arrivingLaunch = arrivingSmartLaunchFrom(returnSearch)

// Settle the address bar before the target is read. A load opened with a SMART
// launch (`?iss=`, and `launch` for an EHR launch) targets the server `iss`
// names; a return leg sheds its authorization response, success or failure
// alike. Safe to do synchronously: `completeSignIn` below redeems the code from
// the captured `returnSearch`, not from the live URL.
const settledSearch = searchSettledFrom(returnSearch)
if (settledSearch !== returnSearch) {
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${settledSearch}${window.location.hash}`
  )
}

const initialServerUrl = currentServerUrl()
renderAuthControls(initialServerUrl)

// The server a return leg's sign-in was for. Read now: `completeSignIn` drops
// the pending record it is read from.
const pendingServerUrl = returningFromAuthorization
  ? pendingSignInServerUrl(signInEnvironment.store, signInEnvironment.pendingKey)
  : undefined

// Mount the reference now on an ordinary load. On a return leg, defer it: a
// successful sign-in re-targets the reference at the signed-in server, so mounting
// the multi-megabyte Scalar bundle against the page's target first would only
// be torn down and rebuilt. Each way the return resolves below mounts it exactly
// once — `applyServerUrl` on success, `returnWithoutSession` otherwise.
if (!returningFromAuthorization) render(initialServerUrl)

/**
 * Mount a return leg that brought no session back against the server its
 * sign-in was for, or the page's own target when no pending record names one.
 */
const returnWithoutSession = (): void => {
  if (pendingServerUrl === undefined) render(initialServerUrl)
  else applyServerUrl(pendingServerUrl)
}

// A return leg from `/oauth/authorize` looks like any other load until the query
// string is read, so every load asks. `?server=` is restored from the pending
// record rather than the URL: the registered redirect URI carries no query.
runSignInEffect(
  completeSignIn(returnSearch, signInEnvironment),
  (result) => {
    if (Option.isNone(result)) {
      if (returningFromAuthorization) returnWithoutSession()
      return
    }
    session = result.value
    scheduleExpiryNotice(result.value)
    applyServerUrl(result.value.serverUrl)
  },
  (error) => {
    if (!returningFromAuthorization) return
    returnWithoutSession()
    // Re-targeting resets the status line; the failure is what it should say.
    showStatus(error.reason, 'problem')
  }
)

// Sign in to the server a launch named straight away, with no click: the
// EHR's launch works once and only for a few minutes. Not when `iss` named no
// usable server (the console stays on the target it would have had without
// the launch, if any), nor when this page cannot reach the server, which the
// status line already says.
if (
  Option.isSome(arrivingLaunch) &&
  normalizeServerUrl(arrivingLaunch.value.iss) !== undefined &&
  initialServerUrl !== undefined &&
  insecureTargetReason(initialServerUrl, { pageIsSecure }) === undefined
) {
  startSigningIn(initialServerUrl, arrivingLaunch.value.launch)
}
