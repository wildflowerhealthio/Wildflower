import { Effect } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { GatekeeperBridge } from 'gatekeeper-core/bridge'
import type { AuthTokenStore } from 'react-kitchen-sink'

import type { ActiveDeviceUserCodeStore } from './active-device-consent/store.ts'

/**
 * Non-secret marker the Tauri `AuthTokenIssued` handler writes into the
 * {@link AuthTokenStore} to flip the auth-readiness signal.
 *
 * The SPA no longer holds the bearer at all: the host plants the `wf_auth`
 * cookie directly in the webview's cookie jar (it rides loopback fetches),
 * and the contentless `AuthTokenIssued` notify just tells the page "the host
 * has an Owner session." Consumers (`useAuthTokenSubscribable`, the auth-ready
 * gate, the rotation invalidator) only check presence, so any non-empty,
 * non-secret value works — keeping the JWT off the JS side entirely.
 */
const HOST_AUTHED_SIGNAL = 'authed'

/**
 * Build the web-side {@link GatekeeperBridge} inbound handler record:
 *
 * - `AuthTokenIssued`: contentless notify that the host has (or refreshed) an
 *   Owner session. The handler flips the auth-readiness signal by writing the
 *   non-secret {@link HOST_AUTHED_SIGNAL} into the {@link AuthTokenStore}; the
 *   actual credential is the `wf_auth` cookie the host syncs into the webview.
 *   The bearer never travels the bridge or the JS side.
 * - `DeviceConsentRequested`: forwards the active pending device-consent head
 *   (or `null` clear) into the SPA's {@link ActiveDeviceUserCodeStore} — the
 *   modal host reads from that store and surfaces the non-dismissable popup
 *   whenever the value is non-null. `null` is meaningful here (no sentinel
 *   guard); the host pushes `null` to dismiss.
 *
 * @remarks
 * Takes only the *setters* because no other handler in this record needs the
 * read sides. Per-entry construction in the page-app entrypoint wires the real
 * stores (Tauri) or no-op setters (web/single-web, where no host emits these).
 */
const makeGatekeeperWebHandlers = (
  setToken: AuthTokenStore['setToken'],
  setActiveDeviceUserCode: ActiveDeviceUserCodeStore['setActiveUserCode']
): MessageHandler.HandlersFor<(typeof GatekeeperBridge)['HostToWeb']> => ({
  AuthTokenIssued: () =>
    Effect.sync(() => {
      setToken(HOST_AUTHED_SIGNAL)
    }),
  DeviceConsentRequested: ({ userCode }) =>
    Effect.sync(() => {
      setActiveDeviceUserCode(userCode)
    }),
})

export { makeGatekeeperWebHandlers, HOST_AUTHED_SIGNAL }
