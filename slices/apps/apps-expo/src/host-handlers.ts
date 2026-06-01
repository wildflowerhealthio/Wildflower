import { AppsBridge } from 'apps-core/bridge'
import { Cause, Effect } from 'effect'
import type { Bridge } from 'effect-messaging-core'
import {
  awaitTunnelOrigin,
  commitRequestedRunning,
  type TunnelStoreService,
} from './commit-and-await-tunnel.ts'

/**
 * Build the host-side inbound handler record for `AppsBridge`.
 * `RequestTunnel` flips `TunnelConfig.requestedRunning`, awaits the
 * tunnel daemon to bind, and replies with `TunnelStarted { origin }`
 * or `TunnelFailed`.
 *
 * @remarks
 * Takes the resolved `TunnelStore` service directly (the caller —
 * typically `useAppsHostBinding` — discharges it from the page's
 * livestore handle via `TunnelStore.layerFrom(store)` before calling).
 *
 * Handler replies route through `AppsBridge.Host.send(...)` directly —
 * the bridge transport's dispatch fiber provides the per-invocation
 * `TransportAdapter` the sender needs.
 */
const makeAppsHostHandlers = (
  tunnelStore: TunnelStoreService
): Bridge.HalfHandlers<(typeof AppsBridge)['Host']> => ({
  RequestTunnel: () =>
    commitRequestedRunning(tunnelStore, true).pipe(
      Effect.andThen(awaitTunnelOrigin(tunnelStore)),
      Effect.matchCauseEffect({
        onSuccess: (origin) => AppsBridge.Host.send({ _tag: 'TunnelStarted', origin }),
        onFailure: (cause) =>
          AppsBridge.Host.send({ _tag: 'TunnelFailed', reason: Cause.pretty(cause) }),
      })
    ),
})

export { makeAppsHostHandlers }
