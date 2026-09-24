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
 * against the app's served root — the origin, plus `basePath` when the copy is
 * published under a subpath.
 *
 * This is the form a single-page app wants. {@link redirectUriForPage} derives
 * the directory, which for a SPA on browser history is whatever section the
 * reader was in when they clicked sign in (`/settings/foo` → `/settings/`) — a
 * different URI per section, so the registered entry could never cover more
 * than one of them. Resolving a fixed route instead makes the value depend on
 * the served root alone, identical on the outbound leg and on the callback
 * (which arrives at that root carrying `code`/`state`).
 *
 * `basePath` is the slash-suffixed directory the build is served from
 * (`branding-core`'s `basenameOf(location.pathname)`); it defaults to `/`, the
 * origin root, so a root-served copy behaves exactly as before. A copy under
 * `/app/` (or a PR preview's `/staging/pr-<n>/app/`) passes that directory so
 * the route returns **under it** — a `/home` route becomes `/app/home` — rather
 * than at `<origin>/home`, off the app. The caller must derive `basePath` at
 * the served root on both legs (so the two derivations agree), which the hosted
 * owner UI does: its sign-in is reachable only from that root.
 *
 * `route` is first resolved against the **origin**, so a `route` that escapes it
 * (`//evil.test/home`, or a `/\evil.test` that `URL` folds into that form)
 * yields `undefined` rather than a URI pointing somewhere else — the same
 * origin-equality guard `gatekeeper-rust` applies to an app-relative allowlist
 * entry in `domain/client_redirect.rs` — before its path is re-rooted under
 * `basePath`.
 */
const redirectUriForRoute = (href: string, route: string, basePath = '/'): string | undefined => {
  const here = returnableUrl(href)
  if (here === undefined) return undefined
  let absolute: URL
  try {
    // Resolve against the origin first: this is the screen that turns a
    // protocol-relative or absolute `route` into a foreign origin the guard
    // below rejects, and it normalizes any `.`/`..` out of the path.
    absolute = new URL(route, here.origin)
  } catch {
    return undefined
  }
  if (absolute.origin !== here.origin) return undefined
  let target: URL
  try {
    // Re-root the now origin-safe route path under the served base. `basePath`
    // needs its trailing slash for `URL` to treat it as a directory rather than
    // a sibling to replace.
    const servedRoot = new URL(basePath.endsWith('/') ? basePath : `${basePath}/`, here.origin)
    target = new URL(absolute.pathname.replace(/^\/+/, ''), servedRoot)
  } catch {
    return undefined
  }
  if (target.origin !== here.origin) return undefined
  return asRedirectUri(target)
}

export { redirectUriForPage, redirectUriForRoute }
