/**
 * Where a static Wildflower page tells the authorization server to send the
 * reader back to.
 *
 * Why this is derived rather than listed, and why an unregistered redirect is
 * not a dead end, is "Deriving the redirect URI" in the package README.
 */

import { isLoopbackHost } from './smart-discovery.ts'

/**
 * The page `href` names, or `undefined` when it is served somewhere a sign-in
 * must not return to. Accepted: `https:` anywhere, `http:` only on loopback,
 * since the flow puts an access token in the browser.
 *
 * The one scheme screen both derivations below go through, so a page and a
 * route can never disagree about which addresses may receive a token.
 */
const returnableUrl = (href: string): URL | undefined => {
  let here: URL
  try {
    here = new URL(href)
  } catch {
    return undefined
  }
  const isSecureEnough =
    here.protocol === 'https:' || (here.protocol === 'http:' && isLoopbackHost(here.hostname))
  return isSecureEnough ? here : undefined
}

/**
 * Render `target` as a `redirect_uri`. Userinfo is dropped (in a `redirect_uri`
 * it would surface in the address bar), and so are the query and fragment — the
 * server matches by exact string equality, so anything the page happened to be
 * carrying would have to be reproduced byte-for-byte on the callback.
 */
const asRedirectUri = (target: URL): string => {
  target.username = ''
  target.password = ''
  target.search = ''
  target.hash = ''
  return target.href
}

/**
 * The `redirect_uri` a page served at `href` should send, or `undefined` when
 * it is served somewhere a sign-in must not return to.
 *
 * The value is the page's **directory** URL — `new URL('.', href)` — so it is
 * identical on the way out and on the callback, whatever query or fragment the
 * page carries.
 */
const redirectUriForPage = (href: string): string | undefined => {
  const here = returnableUrl(href)
  if (here === undefined) return undefined
  return asRedirectUri(new URL('.', here))
}

/**
 * The `redirect_uri` for a page that returns to **one fixed in-app route**
 * rather than to wherever the reader happened to start: `route` resolved
 * against the origin `href` is served from.
 *
 * This is the form a single-page app wants. {@link redirectUriForPage} derives
 * the directory, which for a SPA on browser history is whatever section the
 * reader was in when they clicked sign in (`/settings/foo` → `/settings/`) — a
 * different URI per section, so the registered entry could never cover more
 * than one of them. Resolving a fixed route instead makes the value depend on
 * the origin alone.
 *
 * `route` is resolved against the **origin**, not the current path, so a
 * relative spelling still names a top-level route. A `route` that escapes the
 * origin (`//evil.test/home`, or a `/\evil.test` that `URL` folds into that
 * form) yields `undefined` rather than a URI pointing somewhere else — the same
 * origin-equality guard `gatekeeper-rust` applies to an app-relative allowlist
 * entry in `domain/client_redirect.rs`.
 */
const redirectUriForRoute = (href: string, route: string): string | undefined => {
  const here = returnableUrl(href)
  if (here === undefined) return undefined
  let target: URL
  try {
    target = new URL(route, here.origin)
  } catch {
    return undefined
  }
  if (target.origin !== here.origin) return undefined
  return asRedirectUri(target)
}

export { redirectUriForPage, redirectUriForRoute }
