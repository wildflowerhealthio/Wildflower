import type { AppsBridge } from 'apps-core/bridge'
import { Cause, Effect } from 'effect'
import type { BridgeTransport, MessageHandler } from 'effect-messaging-core'
import {
  awaitTunnelOrigin,
  commitRequestedRunning,
  type TunnelStoreService,
} from './commit-and-await-tunnel.ts'

/** The apps bridge's host→web sender — `RequestTunnel` replies ride this. */
type AppsHostSender = BridgeTransport.MessageSender<readonly [typeof AppsBridge], 'HostToWeb'>

/**
 * Build the host-side inbound handler record for `AppsBridge`.
 * `RequestTunnel` flips `TunnelConfig.requestedRunning`, awaits the
 * tunnel daemon to bind, and replies with `TunnelStarted { origin }`
 * or `TunnelFailed { reason }` through the supplied `reply` sender.
 *
 * @remarks
 * Takes the resolved `TunnelStore` service and the host→web `reply`
 * sender directly — the caller (`useAppsHostBinding`) discharges the
 * store from the page's livestore handle and threads in the transport
 * sender it captured at `onTransportReady`. Handlers stay pure
 * `Effect<void>`; the proactive reply rides the passed-in sender rather
 * than a module-level global.
 */
const makeAppsHostHandlers = (
  tunnelStore: TunnelStoreService,
  reply: AppsHostSender
): MessageHandler.HandlersFor<(typeof AppsBridge)['WebToHost']> => ({
  RequestTunnel: () =>
    commitRequestedRunning(tunnelStore, true).pipe(
      Effect.andThen(awaitTunnelOrigin(tunnelStore)),
      Effect.matchCauseEffect({
        onSuccess: (origin) => reply({ _tag: 'TunnelStarted', origin }),
        onFailure: (cause) => reply({ _tag: 'TunnelFailed', reason: Cause.pretty(cause) }),
      })
    ),
})

export { makeAppsHostHandlers }
export type { AppsHostSender }
