import { Effect } from 'effect'
import { useCallback } from 'react'

import {
  clearPendingTunnelResolverIfCurrent,
  setPendingTunnelResolver,
  type TunnelOutcome,
} from './tunnel-resolver-ref.ts'
import { useAppsSender } from './use-apps-sender.ts'

/**
 * Time (ms) to wait for a `TunnelStarted` / `TunnelFailed` Host→Web
 * response before resolving with a "host unreachable" error. Long
 * enough to cover real localtunnel handshakes; short enough that a
 * standalone-web user (no Expo host) sees a useful error rather than
 * an indefinite spinner.
 */
const TUNNEL_REQUEST_TIMEOUT_MS = 8000

/**
 * Convenience hook: returns a `() => Promise<TunnelOutcome>` that fires
 * `RequestTunnel` on the AppsBridge and awaits the next Host→Web
 * `TunnelStarted` / `TunnelFailed`. Resolves with `{ origin }` on
 * success or `{ error }` on failure (host-reported reason or a local
 * timeout). The caller treats the timeout as "not in a webview" — no
 * separate `isWebView()` probe is necessary; if the host isn't there,
 * no response arrives, and the timeout surfaces the same outcome.
 *
 * Defects in the underlying `send` Effect are caught and logged via
 * `Effect.logError` rather than rejecting the returned promise —
 * callers don't need a `.catch()` to keep the surrounding click
 * handler from blowing up.
 */
const useRequestTunnel = (): (() => Promise<TunnelOutcome>) => {
  const send = useAppsSender()
  return useCallback(
    () =>
      new Promise<TunnelOutcome>((resolve) => {
        let settled = false
        const settle = (outcome: TunnelOutcome): void => {
          if (settled) return
          settled = true
          // Set-if-equal clear: only blank the ref if it still points
          // at this `settle`. A supersede (newer request taking the
          // slot) will have already moved the ref onto the successor.
          clearPendingTunnelResolverIfCurrent(settle)
          clearTimeout(timer)
          resolve(outcome)
        }
        setPendingTunnelResolver(settle)
        const timer = setTimeout(() => {
          settle({ error: 'tunnel request timed out — host unreachable' })
        }, TUNNEL_REQUEST_TIMEOUT_MS)
        Effect.runPromise(
          send({ _tag: 'RequestTunnel' }).pipe(
            Effect.catchAllCause((cause) => Effect.logError('useRequestTunnel: send failed', cause))
          )
        ).catch(() => {
          // `runPromise` shouldn't reject here — `catchAllCause` converts
          // defects to logged successes — but a defensive settle keeps
          // the resolver ref clean if the runtime ever changes.
          settle({ error: 'tunnel request failed to dispatch' })
        })
      }),
    [send]
  )
}

export { useRequestTunnel }
