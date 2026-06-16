import { Effect } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { GatekeeperBridge } from 'gatekeeper-core/bridge'
import type { AuthTokenStore } from 'react-kitchen-sink'

import type { ActiveDeviceUserCodeStore } from './active-device-consent/store.ts'

/**
 * Build the web-side {@link GatekeeperBridge} inbound handler record:
 *
 * - `AuthTokenIssued`: forwards the bearer token through the supplied
 *   {@link AuthTokenStore.setToken} so the same write the device-login
 *   completion uses also flows through here. The empty-string guard
 *   drops the bridge's empty sentinel without rotating the store.
 * - `DeviceConsentRequested`: forwards the active pending
 *   device-consent head (or `null` clear) into the SPA's
 *   {@link ActiveDeviceUserCodeStore} — the modal host reads from
 *   that store and surfaces the non-dismissable popup whenever the
 *   value is non-null. `null` is meaningful here (no sentinel
 *   guard); the host pushes `null` to dismiss.
 *
 * @remarks
 * Takes only the *setters* because no other handler in this record
 * needs the read sides. Per-entry construction in the page-app
 * entrypoint passes the right setters (the Tauri entry wires the real
 * stores; web entries pass no-op setters because their stub transport
 * never receives these messages — the host that emits them only
 * exists in the Tauri shell).
 */
const makeGatekeeperWebHandlers = (
  setToken: AuthTokenStore['setToken'],
  setActiveDeviceUserCode: ActiveDeviceUserCodeStore['setActiveUserCode']
): MessageHandler.HandlersFor<(typeof GatekeeperBridge)['HostToWeb']> => ({
  AuthTokenIssued: ({ token }) =>
    token !== ''
      ? Effect.sync(() => {
          setToken(token)
        })
      : Effect.void,
  DeviceConsentRequested: ({ userCode }) =>
    Effect.sync(() => {
      setActiveDeviceUserCode(userCode)
    }),
})

export { makeGatekeeperWebHandlers }
