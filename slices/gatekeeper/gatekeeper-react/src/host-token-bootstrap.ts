import { type GatekeeperNativeToWeb } from 'gatekeeper-core/message-schemas'
import { type MessageReader } from 'interop-core'
import { consumeUrlParam } from 'interop-react'
import { writeToken } from './client/token-storage.ts'

/**
 * Read a one-shot bearer token from `?token=` and write it to localStorage,
 * stripping it from the address bar so it doesn't persist in history or
 * `Referer` headers. Used by the standalone-web entrypoint where there's
 * no Expo host to deliver `AuthTokenIssued` over the message bridge — see
 * gatekeeper-core's "Bootstrap URL" notes.
 */
const bootstrapTokenFromUrl = (): void => {
  const fromUrl = consumeUrlParam('token')
  if (fromUrl !== null && fromUrl !== '') writeToken(fromUrl)
}

/**
 * Subscribe to {@link AuthTokenIssued} messages from the native host and
 * forward each one's token to localStorage. Used by the embedded
 * (Expo-hosted) entrypoint.
 *
 * Returns the listener disposer so the aggregator can tear it down on
 * unmount; in practice the SPA's lifetime matches the WebView's, so the
 * disposer rarely fires before {@link MessageHandler.dispose}.
 */
const subscribeAuthTokenIssued = (reader: MessageReader<GatekeeperNativeToWeb>): (() => void) =>
  reader.setMessageListener('AuthTokenIssued', ({ token }) => {
    if (token !== '') writeToken(token)
  })

export { bootstrapTokenFromUrl, subscribeAuthTokenIssued }
