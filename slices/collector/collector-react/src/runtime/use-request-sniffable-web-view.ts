import { Effect } from 'effect'
import { useCallback } from 'react'

import { useCollectorSender } from './use-collector-sender.ts'

/**
 * Source the collector SPA hands the host. Mirrors
 * `EffectMessagingWebViewSource` shape so the host can pass it straight
 * through to `<BrowserSnifferWebView>`.
 */
type RequestSniffableWebViewSource =
  | { readonly _tag: 'Uri'; readonly uri: string }
  | { readonly _tag: 'Html'; readonly html: string; readonly baseUrl?: string }

/**
 * Convenience hook: returns a `(source) => Promise<void>` that fires
 * `RequestSniffableWebView` on the CollectorBridge. The host's
 * receiver opens a sniffer-WebView screen for that source and forwards
 * the captured events back through this bridge's Host→Web channel.
 */
const useRequestSniffableWebView = (): ((
  source: RequestSniffableWebViewSource
) => Promise<void>) => {
  const send = useCollectorSender()
  return useCallback(
    (source) => Effect.runPromise(send({ _tag: 'RequestSniffableWebView', source })),
    [send]
  )
}

export { useRequestSniffableWebView }
export type { RequestSniffableWebViewSource }
