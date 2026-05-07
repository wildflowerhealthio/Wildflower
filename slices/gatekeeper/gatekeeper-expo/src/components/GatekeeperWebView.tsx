import { EmbeddedWebView } from 'expo-tundraish'
import { type JSX } from 'react'
import { html } from 'wildflower-react/embeddable-html'

interface GatekeeperWebViewProps {
  readonly baseUrl: string
  readonly route: string
  readonly initialData?: unknown
  readonly token?: string
}

function GatekeeperWebView({
  baseUrl,
  route,
  initialData,
  token,
}: GatekeeperWebViewProps): JSX.Element {
  const parts = [`window.__INITIAL_ROUTE__ = ${JSON.stringify(route)};`]
  if (token !== undefined) {
    // Read by `gatekeeper-web/host-token-bootstrap`, which forwards to
    // `writeToken()` so the storage key stays a single-source-of-truth
    // on the web side.
    parts.push(`window.__GATEKEEPER_TOKEN__ = ${JSON.stringify(token)};`)
  }
  if (initialData !== undefined) {
    parts.push(`window.__GATEKEEPER_INITIAL__ = ${JSON.stringify(initialData)};`)
  }
  const injectedScript = parts.join('\n') + '\ntrue;'

  return <EmbeddedWebView source={{ html, baseUrl }} injectedScript={injectedScript} />
}

export { GatekeeperWebView }
export type { GatekeeperWebViewProps }
