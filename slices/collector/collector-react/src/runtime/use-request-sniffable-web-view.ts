import type { WebViewSource } from 'collector-fundamentals/model'
import { Effect } from 'effect'
import { useCallback } from 'react'

import { useCollectorSender } from './use-collector-sender.ts'

/**
 * Convenience hook: returns a `(source) => Promise<void>` that fires
 * `RequestSniffableWebView` on the CollectorBridge. The host's
 * receiver opens a sniffer-WebView screen for that source and forwards
 * the captured events back through this bridge's Host→Web channel.
 *
 * The source shape is the slice's tagged `WebViewSource.Any` from
 * `collector-fundamentals/model` — the same union the bridge's
 * `RequestSniffableWebView` schema encodes, so the value rides the
 * wire without re-shaping.
 */
const useRequestSniffableWebView = (): ((source: WebViewSource.Any) => Promise<void>) => {
  const send = useCollectorSender()
  return useCallback(
    (source) => Effect.runPromise(send({ _tag: 'RequestSniffableWebView', source })),
    [send]
  )
}

export { useRequestSniffableWebView }
