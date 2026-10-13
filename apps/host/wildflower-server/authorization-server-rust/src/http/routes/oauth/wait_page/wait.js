// The gatekeeper's wait page (`../wait_page.rs`). Polls this request's status
// at the sibling `/oauth/authorize/{id}` until the Owner decides, then leaves
// for the redirect the gatekeeper built from the client's allowlisted
// `redirect_uri`. See "Wait page" in the gatekeeper Jargon Explanation.
//
// Loaded as a module script, so its names stay out of the page's globals.

/** How long to wait between polls, matching the device flow's own cadence. */
const POLL_INTERVAL_MS = 1500
/** Consecutive unreachable polls tolerated before the page gives up. */
const MAX_UNREACHABLE_POLLS = 5
const UNEXPECTED_RESPONSE = 'The authorization server returned an unexpected response.'

/**
 * Show a terminal `state` with its heading and detail. Nothing polls after it.
 *
 * @param {string} state
 * @param {string} heading
 * @param {string} detail
 */
const settle = (state, heading, detail) => {
  document.documentElement.dataset['state'] = state
  const headingElement = document.getElementById('heading')
  const detailElement = document.getElementById('detail')
  if (headingElement !== null) headingElement.textContent = heading
  if (detailElement !== null) detailElement.textContent = detail
}

/** @param {string} detail */
const settleError = (detail) => {
  settle('error', 'Authorization error', detail)
}

/**
 * `redirect` as an absolute `http:`/`https:` URL, or `undefined` for anything
 * else. (`URL.parse` would say this in one call, but older Safari lacks it.)
 *
 * @param {unknown} redirect
 * @returns {URL | undefined}
 */
const followableUrl = (redirect) => {
  if (typeof redirect !== 'string') return undefined
  let target
  try {
    target = new URL(redirect)
  } catch {
    return undefined
  }
  return target.protocol === 'http:' || target.protocol === 'https:' ? target : undefined
}

/**
 * Leave for `redirect`, the client callback the status carried. The gatekeeper
 * builds it from an allowlisted `redirect_uri`; only an `http:`/`https:` URL is
 * followed all the same, so a malformed status can never run script here.
 *
 * @param {unknown} redirect
 */
const leaveFor = (redirect) => {
  const target = followableUrl(redirect)
  if (target === undefined) {
    settleError(UNEXPECTED_RESPONSE)
    return
  }
  document.documentElement.dataset['state'] = 'leaving'
  window.location.replace(target.href)
}

/**
 * Act on one decoded status body: poll again, leave, or settle.
 *
 * @param {string} statusPath
 * @param {{ readonly status?: unknown, readonly redirect?: unknown, readonly message?: unknown }} status
 */
const follow = (statusPath, status) => {
  switch (status.status) {
    case 'pending':
      setTimeout(() => {
        void poll(statusPath, 0)
      }, POLL_INTERVAL_MS)
      return
    case 'approved':
      leaveFor(status.redirect)
      return
    case 'denied':
      // A code-flow denial carries the client's `error=access_denied`
      // callback, so the client learns the outcome too. A device-flow denial
      // has no callback, whether the field is absent or `null`.
      if (status.redirect === undefined || status.redirect === null) {
        settle('denied', 'Request declined', 'The authorization request was declined.')
      } else {
        leaveFor(status.redirect)
      }
      return
    case 'error':
      settleError(
        typeof status.message === 'string'
          ? status.message
          : 'The authorization server encountered an error.'
      )
      return
    default:
      settleError(UNEXPECTED_RESPONSE)
  }
}

/**
 * The human-readable `error_description` of an RFC 6749 §5.2 error body (what
 * the status endpoint answers a `500` with), when it carries a non-empty one.
 *
 * @param {{ readonly error_description?: unknown }} body
 * @returns {string | undefined}
 */
const errorDescription = (body) =>
  typeof body.error_description === 'string' && body.error_description !== ''
    ? body.error_description
    : undefined

/**
 * Poll `statusPath` once. `unreachablePolls` counts the network failures in a
 * row just before this one.
 *
 * @param {string} statusPath
 * @param {number} unreachablePolls
 * @returns {Promise<void>}
 */
const poll = async (statusPath, unreachablePolls) => {
  /** @type {Response} */
  let response
  try {
    response = await fetch(statusPath, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
  } catch {
    if (unreachablePolls + 1 >= MAX_UNREACHABLE_POLLS) {
      settleError('Could not reach the authorization server.')
    } else {
      setTimeout(() => {
        void poll(statusPath, unreachablePolls + 1)
      }, POLL_INTERVAL_MS)
    }
    return
  }
  if (response.status === 404) {
    settleError('This sign-in request was not found. It may have expired; start again.')
    return
  }
  /** @type {unknown} */
  let body
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (typeof body !== 'object' || body === null) {
    settleError(UNEXPECTED_RESPONSE)
    return
  }
  if (!response.ok) {
    settleError(errorDescription(body) ?? UNEXPECTED_RESPONSE)
    return
  }
  follow(statusPath, body)
}

// The page is served at `…/authorize/{id}/wait`; its status is that path
// without the last segment.
const { pathname } = window.location
if (pathname.endsWith('/wait')) void poll(pathname.slice(0, -'/wait'.length), 0)
else settleError('This page was opened at an unexpected address.')
