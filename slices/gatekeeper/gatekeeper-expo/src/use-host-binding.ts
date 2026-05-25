import type { HostBinding } from 'effect-messaging-core'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { useMemo } from 'react'

interface UseGatekeeperHostBindingOptions {
  readonly token?: string
}

/**
 * Host binding for the gatekeeper bridge.
 *
 * - Deliberately ignores `AuthTokenIssued`'s URL-param schema and routes the
 *   token through `onTransportReady` so it never appears in WebView URL logs.
 * - `WaitForToken` is unconditional — without it the embedded SPA can't
 *   distinguish "token coming" from "no host" and falls through to a different
 *   auth path.
 *
 * @remarks
 * Token transitions invalidate the memo (`[token]` dep), which flips the
 * bindings tuple identity and tears down the transport — including a full
 * WebView reload. Once-per-session is fine; rotating sessions remount the SPA.
 */
const useGatekeeperHostBinding = ({
  token,
}: UseGatekeeperHostBindingOptions = {}): HostBinding.HostBinding<typeof GatekeeperBridge> =>
  useMemo(
    () => ({
      bridge: GatekeeperBridge,
      receiverLayer: GatekeeperBridge.Host.ReceiverLayer({}),
      initialMessages: [{ _tag: 'WaitForToken' as const }],
      onTransportReady:
        token === undefined ? undefined : (send) => send({ _tag: 'AuthTokenIssued', token }),
    }),
    [token]
  )

export { useGatekeeperHostBinding }
export type { UseGatekeeperHostBindingOptions }
