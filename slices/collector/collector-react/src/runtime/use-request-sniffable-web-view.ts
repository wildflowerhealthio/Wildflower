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
 *
 * Defects in the underlying `send` Effect are caught and logged via
 * `Effect.logError` rather than rejecting the returned promise —
 * callers don't need a `.catch()` to keep the surrounding click
 * handler from blowing up.
 */
const useRequestSniffableWebView = (): ((source: WebViewSource.Any) => Promise<void>) => {
  const send = useCollectorSender()
  return useCallback(
    (source) =>
      Effect.runPromise(
        send({ _tag: 'RequestSniffableWebView', source }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError('useRequestSniffableWebView: send failed', cause)
          )
        )
      ),
    [send]
  )
}

export { useRequestSniffableWebView }
