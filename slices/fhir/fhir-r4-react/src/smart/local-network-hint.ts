/**
 * The sentence a page adds after a connection failure's reason when the server
 * it connected to is a loopback address and the page itself is secure: any
 * page on the published site (`smart-app-react`'s `ConnectMenu`, the hosted
 * launcher's own sign-in) reaching a server on the reader's own machine.
 *
 * A hosted `https://` page fetching a `http://127.0.0.1` server is exactly the
 * case Chrome guards with its **Local Network Access** prompt (formerly Private
 * Network Access): the request looks like a public origin reaching into the
 * reader's own machine, so Chrome holds it until the reader allows it. To the
 * page that shows up as an ordinary network/CORS failure with no way to tell it
 * apart from a server that is simply down — so when the target is loopback and
 * this page is secure, the reason on its own under-explains, and this names the
 * prompt the reader has to answer.
 *
 * Loopback-only and secure-page-only on purpose: a remote `https` server has no
 * Local Network Access gate, and a dev page served over plain `http` (the
 * loopback origin itself) is not making the public→local jump the prompt is
 * about, so neither gets the hint.
 */

import { isLoopbackHost } from '@wildflowerhealthio/gatekeeper-core/smart-client'

/**
 * The Local Network Access hint for `serverUrl`, or `undefined` when it does not
 * apply — a non-loopback target, an unparseable one, or a page that is not
 * itself secure.
 */
const localNetworkAccessHint = (
  serverUrl: string,
  options: { readonly pageIsSecure: boolean }
): string | undefined => {
  if (!options.pageIsSecure) return undefined
  let hostname: string
  try {
    hostname = new URL(serverUrl).hostname
  } catch {
    return undefined
  }
  if (!isLoopbackHost(hostname)) return undefined
  return (
    'If the server is running on this computer, Chrome may be holding the request ' +
    'behind its “Local Network Access” prompt. Allow this site to reach the local ' +
    'network, then try again.'
  )
}

/**
 * `reason` with the {@link localNetworkAccessHint} for `serverUrl` after it,
 * when the hint applies; `reason` alone otherwise. The one way a page joins the
 * two, so the hint reads the same wherever it is shown.
 */
const withLocalNetworkAccessHint = (
  reason: string,
  serverUrl: string,
  options: { readonly pageIsSecure: boolean }
): string => {
  const hint = localNetworkAccessHint(serverUrl, options)
  return hint === undefined ? reason : `${reason} ${hint}`
}

export { localNetworkAccessHint, withLocalNetworkAccessHint }
