import { Effect } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { GatekeeperBridge } from 'gatekeeper-core/bridge'
import type { AuthTokenStore } from 'react-kitchen-sink'

import type { ActiveDeviceUserCodeStore } from './active-device-consent/store.ts'

/**
 * Pull the current Owner bearer from the host. `AuthTokenIssued` is a
 * contentless notify — the secret never rides the bridge channel —
 * so the handler delegates to this fetcher, which the page-app entry
 * implements per-platform (Tauri: capability-gated
 * `gatekeeper_current_token` invoke; embedded/web: no-op resolving to
 * `null` because no host emits the notify on that path). Returning
 * `null` is a legitimate "no token yet" state during the brief boot
 * window before the host mints one — the store is left unchanged.
 */
type PullCurrentToken = () => Effect.Effect<string | null>

/**
 * Build the web-side {@link GatekeeperBridge} inbound handler record:
 *
 * - `AuthTokenIssued`: contentless notify that the host has a fresh
 *   bearer ready. The handler calls {@link PullCurrentToken} to fetch
 *   it out-of-band (so the secret never travels on the multiplexed
 *   bridge channel that sibling webviews can subscribe to) and
 *   forwards a non-empty result through the supplied
 *   {@link AuthTokenStore.setToken}. A `null` pull or empty token is
 *   ignored without rotating the store.
 * - `DeviceConsentRequested`: forwards the active pending
 *   device-consent head (or `null` clear) into the SPA's
 *   {@link ActiveDeviceUserCodeStore} — the modal host reads from
 *   that store and surfaces the non-dismissable popup whenever the
 *   value is non-null. `null` is meaningful here (no sentinel
 *   guard); the host pushes `null` to dismiss.
 *
 * @remarks
 * Takes only the *setters* (and the platform-specific pull function)
 * because no other handler in this record needs the read sides.
 * Per-entry construction in the page-app entrypoint wires the Tauri
 * invoke or a no-op puller, the same way it wires the real stores or
 * no-op setters.
 */
const makeGatekeeperWebHandlers = (
  setToken: AuthTokenStore['setToken'],
  setActiveDeviceUserCode: ActiveDeviceUserCodeStore['setActiveUserCode'],
  pullCurrentToken: PullCurrentToken
): MessageHandler.HandlersFor<(typeof GatekeeperBridge)['HostToWeb']> => ({
  AuthTokenIssued: () =>
    Effect.flatMap(pullCurrentToken(), (token) =>
      token !== null && token !== ''
        ? Effect.sync(() => {
            setToken(token)
          })
        : Effect.void
    ),
  DeviceConsentRequested: ({ userCode }) =>
    Effect.sync(() => {
      setActiveDeviceUserCode(userCode)
    }),
})

export { makeGatekeeperWebHandlers }
export type { PullCurrentToken }
