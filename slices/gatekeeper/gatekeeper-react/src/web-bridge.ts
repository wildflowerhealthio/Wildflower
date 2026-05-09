import { Effect } from 'effect'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { writeToken } from './client/token-storage.ts'

/**
 * Web-side {@link GatekeeperBridge} `ReceiverLayer` — registers the
 * `AuthTokenIssued` handler that writes incoming tokens to local
 * storage. Aggregators (the embedded SPA's `main-embedded.tsx`) wire
 * this layer alongside the navigation bridge's layer when constructing
 * the web transport.
 *
 * Effect-typed so logging / future async work composes naturally; the
 * current body is a sync `writeToken` call wrapped with `Effect.sync`.
 */
const gatekeeperWebReceiverLayer = GatekeeperBridge.Web.ReceiverLayer({
  AuthTokenIssued: ({ token }) =>
    Effect.sync(() => {
      if (token !== '') writeToken(token)
    }),
})

export { gatekeeperWebReceiverLayer }
