import type { Effect } from 'effect'
import type { BindingSend, SliceHostBinding } from 'effect-messaging-core'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { useMemo } from 'react'
import { ReceiverLayer } from './host-receiver-layer.ts'

interface UseGatekeeperHostBindingOptions {
  /**
   * Bearer token issued to the embedded SPA on boot. When non-null, the
   * binding's `onTransportReady` posts `AuthTokenIssued { token }`
   * through the bridge transport — *not* on the URL-param channel — so
   * the token never appears in native WebView URL logs or Sentry
   * breadcrumbs.
   */
  readonly token?: string
}

/**
 * Build a {@link SliceHostBinding} for the gatekeeper bridge. The
 * gatekeeper host has no inbound handlers; the binding exists so the
 * bridge participates in the transport handshake AND so the
 * token-dispatch invariant ("never via URL params") lives next to the
 * slice instead of as a comment in the host shell.
 *
 * @remarks
 * `AuthTokenIssued` does carry a `urlParams` schema (added so app-side
 * tests can exercise the URL-param path), but this binding deliberately
 * routes the bearer through `onTransportReady` instead — the bridge
 * transport's outbound queue holds the message until the SPA is ready,
 * matching the URL-param-channel semantics without the logging risk.
 */
const useGatekeeperHostBinding = ({
  token,
}: UseGatekeeperHostBindingOptions = {}): SliceHostBinding<typeof GatekeeperBridge> =>
  useMemo(
    () => ({
      bridge: GatekeeperBridge,
      receiverLayer: ReceiverLayer(),
      onTransportReady:
        token === undefined
          ? undefined
          : (send: BindingSend): Effect.Effect<void> => send({ _tag: 'AuthTokenIssued', token }),
    }),
    [token]
  )

export { useGatekeeperHostBinding }
export type { UseGatekeeperHostBindingOptions }
