import { EmbeddedWebView } from 'expo-tundraish'
import { html } from 'gatekeeper-web/html'
import { type JSX } from 'react'

interface GatekeeperWebViewProps {
  readonly baseUrl: string
  readonly route: string
  readonly initialData?: unknown
}

function GatekeeperWebView({ baseUrl, route, initialData }: GatekeeperWebViewProps): JSX.Element {
  const parts = [`window.__INITIAL_ROUTE__ = ${JSON.stringify(route)};`]
  if (initialData !== undefined) {
    parts.push(`window.__GATEKEEPER_INITIAL__ = ${JSON.stringify(initialData)};`)
  }
  const injectedScript = parts.join('\n') + '\ntrue;'

  return <EmbeddedWebView source={{ html, baseUrl }} injectedScript={injectedScript} />
}

export { GatekeeperWebView }
export type { GatekeeperWebViewProps }
