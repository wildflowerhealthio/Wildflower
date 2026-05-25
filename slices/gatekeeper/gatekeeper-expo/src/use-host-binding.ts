import type { HostBinding } from 'effect-messaging-core'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { useMemo } from 'react'
import { ReceiverLayer } from './host-receiver-layer.ts'

interface UseGatekeeperHostBindingOptions {
  /**
   * Bearer token issued to the embedded SPA on boot. Routed through
   * `onTransportReady` — *not* the URL-param channel — so the token
   * never appears in native WebView URL logs.
   */
  readonly token?: string
}

/**
 * Host binding for the gatekeeper bridge. The token-dispatch policy
 * ("never via URL params") lives here instead of as a comment in the
 * host shell — `AuthTokenIssued` does carry a URL-param schema but the
 * binding deliberately ignores it.
 *
 * Always announces `WaitForToken` at boot via URL params — the Expo
 * host commits to delivering an `AuthTokenIssued` once `LocalClientToken`
 * is minted, so the embedded SPA's auth gate must hold (loader) rather
 * than fall through to the device-flow UI while it waits. The flag is
 * processed during transport drain, before the React tree mounts.
 */
const useGatekeeperHostBinding = ({
  token,
}: UseGatekeeperHostBindingOptions = {}): HostBinding.HostBinding<typeof GatekeeperBridge> =>
  useMemo(
    () => ({
      bridge: GatekeeperBridge,
      receiverLayer: ReceiverLayer(),
      initialMessages: [{ _tag: 'WaitForToken' as const }],
      onTransportReady:
        token === undefined ? undefined : (send) => send({ _tag: 'AuthTokenIssued', token }),
    }),
    [token]
  )

export { useGatekeeperHostBinding }
export type { UseGatekeeperHostBindingOptions }
