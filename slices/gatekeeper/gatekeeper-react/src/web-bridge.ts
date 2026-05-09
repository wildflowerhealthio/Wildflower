import { Effect } from 'effect'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { writeToken } from './client/token-storage.ts'

/** Web-side {@link GatekeeperBridge} `ReceiverLayer`: writes received tokens to local storage. */
const gatekeeperWebReceiverLayer = GatekeeperBridge.Web.ReceiverLayer({
  AuthTokenIssued: ({ token }) =>
    Effect.sync(() => {
      if (token !== '') writeToken(token)
    }),
})

export { gatekeeperWebReceiverLayer }
