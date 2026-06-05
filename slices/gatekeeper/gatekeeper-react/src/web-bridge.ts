import { Effect } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { GatekeeperBridge } from 'gatekeeper-core/bridge'
import type { AuthTokenStore } from 'react-kitchen-sink'

import type { ActiveDeviceRequestStore } from './active-device-request/index.ts'

/**
 * Build the web-side {@link GatekeeperBridge} inbound handler record:
 *
 * - `AuthTokenIssued`: forwards the bearer token through the
 *   supplied {@link AuthTokenStore.setToken} so the same write the
 *   device-login completion uses also flows through here. The
 *   empty-string guard drops the bridge's empty sentinel without
 *   rotating the store.
 * - `DeviceAuthorizationActiveChanged`: forwards the live device-consent
 *   head (`userCode`, or `null` to dismiss) into
 *   {@link ActiveDeviceRequestStore.setActiveUserCode}, which the modal
 *   host observes. `null` is a meaningful value here, so there is no
 *   sentinel guard — every push is applied verbatim.
 *
 * @remarks
 * Takes the two writers rather than the whole stores because no handler
 * needs a read side. Per-entry construction in the page-app entrypoint
 * passes the right writers (web stores persist to `localStorage`;
 * embedded stores live in memory only) — this function and the rest of
 * the page-bridge wiring stay environment-blind. On standalone-web
 * entries the host never pushes `DeviceAuthorizationActiveChanged`, so
 * the device handler is simply never invoked.
 */
const makeGatekeeperWebHandlers = (
  setToken: AuthTokenStore['setToken'],
  setActiveDeviceUserCode: ActiveDeviceRequestStore['setActiveUserCode']
): MessageHandler.HandlersFor<(typeof GatekeeperBridge)['HostToWeb']> => ({
  AuthTokenIssued: ({ token }) =>
    token !== ''
      ? Effect.sync(() => {
          setToken(token)
        })
      : Effect.void,
  DeviceAuthorizationActiveChanged: ({ userCode }) =>
    Effect.sync(() => {
      setActiveDeviceUserCode(userCode)
    }),
})

export { makeGatekeeperWebHandlers }
