/**
 * Where a static Wildflower page tells the authorization server to send the
 * reader back to.
 *
 * A page that signs in has to hand `/oauth/authorize` a `redirect_uri`, and the
 * server matches it by **exact string equality** against the client's
 * allowlist. So the string cannot be `location.href` — that carries the page's
 * own query and fragment, and on the return leg it carries `code` and `state`
 * too. What it can be is the page's own directory URL, which is stable across
 * the whole round trip.
 *
 * Deriving it, rather than matching `location` against a list of addresses the
 * page was built for, is what lets one build sign in from wherever it is
 * served: the published site, a PR preview under
 * `wildflowerhealth.io/staging/pr-<n>/`, a local dev server. A redirect the
 * client has not registered is not rejected at `/authorize` — for every client
 * but the first-party host it reaches the Owner as a "this redirect is new"
 * consent warning, and approving it adds the entry (see
 * `gatekeeper-rust`'s `domain/client_registration.rs`). The Owner's consent is
 * the gate, not a list compiled into the page.
 */

import { isLoopbackHost } from './smart-discovery.ts'

/**
 * The `redirect_uri` a page served at `href` should send, or `undefined` when
 * it is served somewhere a sign-in could not safely return to.
 *
 * The value is the page's **directory** URL — `new URL('.', href)`, the same
 * derivation the fhirclient-based apps use — so it is identical on the way out
 * and on the way back, whatever query or fragment the page is carrying at the
 * time. A page at `/docs/index.html` and the same page at `/docs/` both yield
 * `/docs/`, which is also the form a static host canonicalises to before the
 * page ever loads.
 *
 * Accepted: any `https:` page, and an `http:` page on a loopback host (a dev
 * server). Rejected: `http:` anywhere else — the flow puts an access token in
 * the browser, and a plaintext origin would put it on the wire in the clear —
 * and every non-http(s) scheme (`file:`, `blob:`, an extension origin), which
 * could not complete a redirect anyway. Userinfo is dropped; a `redirect_uri`
 * carrying credentials would surface them in the address bar.
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
