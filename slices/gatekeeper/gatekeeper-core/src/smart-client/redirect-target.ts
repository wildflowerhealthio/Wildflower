/**
 * Where a static Wildflower page tells the authorization server to send the
 * reader back to.
 *
 * Why this is derived rather than listed, and why an unregistered redirect is
 * not a dead end, is "Deriving the redirect URI" in the package README.
 */

import { isLoopbackHost } from './smart-discovery.ts'

/**
 * The `redirect_uri` a page served at `href` should send, or `undefined` when
 * it is served somewhere a sign-in must not return to.
 *
 * The value is the page's **directory** URL — `new URL('.', href)` — so it is
 * identical on the way out and on the callback, whatever query or fragment the
 * page carries. Accepted: `https:` anywhere, `http:` only on loopback, since
 * the flow puts an access token in the browser. Userinfo is dropped; in a
 * `redirect_uri` it would surface in the address bar.
 */
const redirectUriForPage = (href: string): string | undefined => {
  let here: URL
  try {
    here = new URL(href)
  } catch {
    return undefined
  }
  const isSecureEnough =
    here.protocol === 'https:' || (here.protocol === 'http:' && isLoopbackHost(here.hostname))
  if (!isSecureEnough) return undefined
  const directory = new URL('.', here)
  directory.username = ''
  directory.password = ''
  return directory.href
}

export { redirectUriForPage }
