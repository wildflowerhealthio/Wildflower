import { Effect } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { type AuthStateStore, HostAuthed } from 'react-kitchen-sink'

import type { ActiveDeviceUserCodeStore } from './active-device-consent/store.ts'

/**
 * Build the web-side {@link GatekeeperBridge} inbound handler record:
 *
 * - `AuthTokenIssued`: contentless notify that the host has (or refreshed) an
 *   Owner session. The handler flips the auth-readiness signal by publishing
 *   `HostAuthed` into the {@link AuthStateStore}; the actual credential is the
 *   `wf_auth` cookie the host syncs into the webview. The bearer never travels
 *   the bridge or the JS side, and the page holds no token, so `HostAuthed`
 *   (authed, no page-known expiry) is exactly the signal this platform can make.
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
  setAuthState: AuthStateStore['setAuthState'],
  setActiveDeviceUserCode: ActiveDeviceUserCodeStore['setActiveUserCode']
): MessageHandler.HandlersFor<(typeof GatekeeperBridge)['HostToWeb']> => ({
  AuthTokenIssued: () =>
    Effect.sync(() => {
      setAuthState(HostAuthed())
    }),
  DeviceConsentRequested: ({ userCode }) =>
    Effect.sync(() => {
      setActiveDeviceUserCode(userCode)
    }),
})

export { makeGatekeeperWebHandlers }
