import { AppsBridge } from 'apps-core/bridge'
import { Effect } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { useHandlerCoordinator } from 'effect-messaging-react'
import { useCallback } from 'react'

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
 * The tunnel-response outcomes a pending `useRequestTunnel` call resolves
 * with. Mirrors the AppsBridge Host→Web messages — `TunnelStarted`
 * carries the new origin, `TunnelFailed` a human-readable reason —
 * flattened into the shape callers observe (`{ origin } | { error }`).
 */
type TunnelOutcome = { readonly origin: string } | { readonly error: string }

/**
 * The in-flight tunnel request's settle, tracked so a newer request can
 * **supersede** it (settle the predecessor with an error before taking
 * the slot) — otherwise the prior Promise dangles and a stale host
 * response could resolve the new request. Module-level because the page
 * has exactly one Apps tunnel slot.
 */
let pendingSettle: ((outcome: TunnelOutcome) => void) | null = null

/**
 * Convenience hook: returns a `() => Promise<TunnelOutcome>` that
 * registers a resolver-bound `Apps` handler record, fires `RequestTunnel`,
 * and awaits the next Host→Web `TunnelStarted` / `TunnelFailed`. Resolves
 * with `{ origin }` on success or `{ error }` on failure (host-reported
 * reason or a local timeout). The caller treats the timeout as "not in a
 * webview" — if the host isn't there, no response arrives, and the
 * timeout surfaces the same outcome.
 *
 * Defects in the underlying `send` Effect are caught and logged via
 * `Effect.logError` rather than rejecting the returned promise — callers
 * don't need a `.catch()` to keep the surrounding click handler from
 * blowing up.
 */
const useRequestTunnel = (): (() => Promise<TunnelOutcome>) => {
  const send = useAppsSender()
  const coordinator = useHandlerCoordinator<readonly [typeof AppsBridge]>()
  return useCallback(
    () =>
      new Promise<TunnelOutcome>((resolve) => {
        let settled = false
        const settle = (outcome: TunnelOutcome): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (pendingSettle === settle) pendingSettle = null
          // Set-if-equal: the coordinator only relinquishes the Apps slot
          // if it still holds this request's record (a supersede may have
          // already replaced it).
          Effect.runFork(
            coordinator
              .unregister(AppsBridge, record)
              .pipe(
                Effect.catchAll((error) =>
                  Effect.logError('useRequestTunnel: handler unregistration failed', error)
                )
              )
          )
          resolve(outcome)
        }
        // Supersede: settle any in-flight predecessor before this request
        // takes the slot.
        if (pendingSettle !== null) pendingSettle({ error: 'superseded by newer request' })
        pendingSettle = settle

        // The real, resolver-bound inbound handler for this request — no
        // forwarder cell, registered straight through the coordinator.
        const record: MessageHandler.HandlersFor<(typeof AppsBridge)['HostToWeb']> = {
          TunnelStarted: ({ origin }) => Effect.sync(() => settle({ origin })),
          TunnelFailed: ({ reason }) => Effect.sync(() => settle({ error: reason })),
        }
        Effect.runFork(
          coordinator
            .register(AppsBridge, record)
            .pipe(
              Effect.catchAll((error) =>
                Effect.logError('useRequestTunnel: handler registration failed', error)
              )
            )
        )

        const timer = setTimeout(() => {
          settle({ error: 'tunnel request timed out — host unreachable' })
        }, TUNNEL_REQUEST_TIMEOUT_MS)
        Effect.runPromise(
          send({ _tag: 'RequestTunnel' }).pipe(
            Effect.catchAllCause((cause) => Effect.logError('useRequestTunnel: send failed', cause))
          )
        ).catch(() => {
          // `runPromise` shouldn't reject here — `catchAllCause` converts
          // defects to logged successes — but a defensive settle keeps the
          // slot clean if the runtime ever changes.
          settle({ error: 'tunnel request failed to dispatch' })
        })
      }),
    [send, coordinator]
  )
}

export { useRequestTunnel }
export type { TunnelOutcome }
