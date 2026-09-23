import { Effect } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { type AuthStateStore, HostAuthed } from 'react-kitchen-sink'

import type { ActivePendingConsentStore } from './active-pending-consent/store.ts'

/**
 * Build the web-side {@link GatekeeperBridge} inbound handler record:
 *
 * - `AuthTokenIssued`: contentless notify that the host has (or refreshed) an
 *   Owner session. The handler flips the auth-readiness signal by publishing
 *   `HostAuthed` into the {@link AuthStateStore}; the actual credential is the
 *   `wf_auth` cookie the host syncs into the webview. The bearer never travels
 *   the bridge or the JS side, and the page holds no token, so `HostAuthed`
 *   (authed, no page-known expiry) is exactly the signal this platform can make.
 * - `PendingConsentRequested`: forwards the active pending-consent head
 *   (or `null` clear) into the SPA's {@link ActivePendingConsentStore} — the
 *   modal host reads from that store and surfaces the popup
 *   whenever the value is non-null, branching on the head's `kind` to pick the
 *   device or authorization-code consent form. `null` is meaningful here (no
 *   sentinel guard); the host pushes `null` to dismiss.
 *
 * @remarks
 * Takes only the *setters* because no other handler in this record needs the
 * read sides. Per-entry construction in the page-app entrypoint wires the real
 * stores (Tauri) or no-op setters (web, where no host emits these).
 */
const makeGatekeeperWebHandlers = (
  setAuthState: AuthStateStore['setAuthState'],
  setActivePendingConsent: ActivePendingConsentStore['setActiveHead']
): MessageHandler.HandlersFor<(typeof GatekeeperBridge)['HostToWeb']> => ({
  AuthTokenIssued: () =>
    Effect.sync(() => {
      setAuthState(HostAuthed())
    }),
  PendingConsentRequested: ({ head }) =>
    Effect.sync(() => {
      setActivePendingConsent(head)
    }),
})

export { makeGatekeeperWebHandlers }
