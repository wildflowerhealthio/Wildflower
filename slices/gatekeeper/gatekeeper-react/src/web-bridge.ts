import { Effect } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { GatekeeperBridge } from 'gatekeeper-core/bridge'
import type { AuthTokenStore } from 'react-kitchen-sink'

/**
 * Build the web-side {@link GatekeeperBridge} inbound handler record:
 *
 * - `AuthTokenIssued`: forwards the bearer token through the
 *   supplied {@link AuthTokenStore.setToken} so the same write the
 *   device-login completion uses also flows through here. The
 *   empty-string guard drops the bridge's empty sentinel without
 *   rotating the store.
 *
 * @remarks
 * Takes `setToken` rather than the whole store because no other handler
 * needs the read side. Per-entry construction in the
 * page-app entrypoint passes the right setter (web stores persist to
 * `localStorage`; embedded stores live in memory only) — this
 * function and the rest of the page-bridge wiring stay
 * environment-blind.
 */
const makeGatekeeperWebHandlers = (
  setToken: AuthTokenStore['setToken']
): MessageHandler.HandlersFor<(typeof GatekeeperBridge)['HostToWeb']> => ({
  AuthTokenIssued: ({ token }) =>
    token !== ''
      ? Effect.sync(() => {
          setToken(token)
        })
      : Effect.void,
})

export { makeGatekeeperWebHandlers }
