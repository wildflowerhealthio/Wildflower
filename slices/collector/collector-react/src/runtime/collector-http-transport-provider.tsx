import { useMemo, type JSX, type ReactNode } from 'react'

import { CollectorRegisterContext } from './collector-register-context.ts'
import { CollectorSenderContext } from './collector-sender-context.ts'
import { makeHttpCollectorTransport } from './http-collector-transport.ts'

interface CollectorHttpTransportProviderProps {
  /**
   * Absolute API origin for entries whose page is not served by the API
   * server (the Tauri webview loads from the dev server / asset protocol
   * while the API lives on the host's loopback origin). Omitted, requests
   * stay relative to the page origin and the events WebSocket derives from
   * it — the web/tunnel case.
   */
  readonly apiBaseUrl?: string | undefined
  readonly children: ReactNode
}

/**
 * Provides the collector runtime's transport — the `/sniffer` REST sender
 * and the `/sniffer/events` WebSocket register — to the collector screens.
 * The HTTP replacement for the app's retired `CollectorSenderForwarder`
 * (which fed the Tauri bridge's `sendMessage` into the sender context).
 */
const CollectorHttpTransportProvider = ({
  apiBaseUrl,
  children,
}: CollectorHttpTransportProviderProps): JSX.Element => {
  const transport = useMemo(() => makeHttpCollectorTransport({ apiBaseUrl }), [apiBaseUrl])
  return (
    <CollectorSenderContext.Provider value={transport.sender}>
      <CollectorRegisterContext.Provider value={transport.register}>
        {children}
      </CollectorRegisterContext.Provider>
    </CollectorSenderContext.Provider>
  )
}

export { CollectorHttpTransportProvider }
export type { CollectorHttpTransportProviderProps }
