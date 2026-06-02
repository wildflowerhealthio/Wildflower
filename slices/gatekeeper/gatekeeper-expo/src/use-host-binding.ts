import { Effect } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import { HostBindings } from 'effect-messaging-core'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { useEffect, useMemo, useRef, useState } from 'react'

interface UseGatekeeperHostBindingOptions {
  readonly token?: string
}

type GatekeeperSender = BridgeTransport.MessageSender<
  readonly [typeof GatekeeperBridge],
  'HostToWeb'
>

/**
 * Host binding for the gatekeeper bridge.
 *
 * The bearer token is deliberately kept off the WebView URL and instead
 * delivered through `onTransportReady`'s captured sender so it never
 * appears in WebView URL logs.
 *
 * @remarks
 * Binding identity is **stable** across `token` transitions: the
 * `useMemo` deps are empty and `onTransportReady` only captures the
 * sender into a ref. Token delivery is driven by a post-mount
 * `useEffect` that runs `AuthTokenIssued` once both transport-ready
 * and token-available are true. This eliminates the cold-start
 * double-build flash (transport torn down + rebuilt + WebView reload)
 * that the previous `[token]`-keyed memo caused when the host's token
 * minted after the initial render.
 *
 * Token rotation flows the new value through the same effect without a
 * rebuild — the SPA receives a fresh `AuthTokenIssued` over the live
 * transport instead of remounting. Ordering under rapid rotation needs
 * no fiber chaining: `send` offers synchronously into the transport's
 * single FIFO outbox (the one ordering authority), so successive
 * rotations dispatch in declared order.
 */
const useGatekeeperHostBinding = ({
  token,
}: UseGatekeeperHostBindingOptions = {}): HostBindings.HostBindings<
  readonly [typeof GatekeeperBridge]
> => {
  const senderRef = useRef<GatekeeperSender | null>(null)
  const [transportReady, setTransportReady] = useState(false)

  useEffect(() => {
    if (!transportReady || token === undefined) return
    const send = senderRef.current
    if (send === null) return
    Effect.runFork(send({ _tag: 'AuthTokenIssued', token }))
  }, [token, transportReady])

  return useMemo(
    () =>
      HostBindings.single({
        bridge: GatekeeperBridge,
        handlers: {},
        initialMessages: [],
        onTransportReady: (send: GatekeeperSender) =>
          Effect.sync(() => {
            senderRef.current = send
            setTransportReady(true)
          }),
      }),
    []
  )
}

export { useGatekeeperHostBinding }
export type { UseGatekeeperHostBindingOptions }
