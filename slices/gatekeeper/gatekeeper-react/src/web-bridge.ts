import { Effect } from 'effect'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { consumeUrlParam } from 'interop-react'
import { writeToken } from './client/token-storage.ts'

/**
 * Read a one-shot bearer token from `?token=` and write it to localStorage,
 * stripping it from the address bar so it doesn't persist in history or
 * `Referer` headers. Used by the standalone-web entrypoint where there's
 * no Expo host to deliver `AuthTokenIssued` over the bridge — see
 * gatekeeper-core's "Bootstrap URL" notes.
 */
const bootstrapTokenFromUrl = (): void => {
  const fromUrl = consumeUrlParam('token')
  if (fromUrl !== null && fromUrl !== '') writeToken(fromUrl)
}

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

export { bootstrapTokenFromUrl, gatekeeperWebReceiverLayer }
